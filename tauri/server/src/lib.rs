//! Lanmd 服务端（Rust 实现）：提供 HTTP API + SSE 实时广播，前端静态资源内嵌。
//! 磁盘是唯一真相源；版本号校验 + SSE 单向广播；无任何协同编辑机制。

pub mod config;
mod error;
mod events;
mod hash;
pub mod lan;
mod static_files;
mod timed;
mod vault;
mod watcher;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use events::{BusEvent, EventBus};
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

pub use config::{load_config, Config};
pub use error::ApiError;

pub struct StartOpts {
    /// config.json 与默认 vault 所在目录
    pub data_dir: PathBuf,
    /// 前端静态资源目录；None = 使用编译期内嵌 web/dist
    pub web_dist: Option<PathBuf>,
}

pub struct RunningServer {
    pub port: u16,
    pub vault: String,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    done_rx: tokio::sync::oneshot::Receiver<()>,
}

impl RunningServer {
    /// 优雅停服：广播 shutdown 信号使全部 SSE 流立即断开，
    /// 随后 graceful shutdown 并释放 watcher。3 秒超时兜底，保证 stop() 必然返回。
    pub async fn stop(self) {
        let _ = self.shutdown_tx.send(true);
        if let Err(_timeout) =
            tokio::time::timeout(Duration::from_secs(3), self.done_rx).await
        {
            log::warn!("stop() 超过 3s 兜底时限，继续返回");
        }
    }
}

struct AppState {
    cfg: RwLock<Config>,
    vault: Arc<vault::Vault>,
    bus: EventBus,
    token_from_env: bool,
    persist: Arc<dyn Fn(&Config) + Send + Sync>,
    web_dist: Option<PathBuf>,
    pair_attempts: RwLock<HashMap<IpAddr, (u32, Instant)>>,
    watcher: RwLock<Option<watcher::WatcherHandle>>,
    shutdown_rx: tokio::sync::watch::Receiver<bool>,
}

pub async fn start_server(opts: StartOpts) -> Result<RunningServer, ApiError> {
    let loaded = config::load_config(&opts.data_dir);
    let cfg = loaded.cfg;
    let persist = loaded.persist;

    // port 越界在 config.rs 已回退默认并告警；这里再防线：0 端口无意义
    if cfg.port == 0 {
        return Err(ApiError::bad("port 不能为 0"));
    }

    let bus = EventBus::new();
    let vault = Arc::new(vault::Vault::new(Arc::new(cfg.clone()), bus.clone()));
    let timed = Arc::new(timed::TimedVault::new(vault.clone()));

    let watcher_handle = watcher::start(vault.clone(), bus.clone())
        .map_err(|e| ApiError::internal(format!("watcher 启动失败: {e}")))?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();

    let state = Arc::new(AppState {
        cfg: RwLock::new(cfg.clone()),
        vault: vault.clone(),
        bus: bus.clone(),
        token_from_env: std::env::var("MDLIVE_TOKEN").is_ok_and(|v| !v.is_empty()),
        persist,
        web_dist: opts.web_dist,
        pair_attempts: RwLock::new(HashMap::new()),
        watcher: RwLock::new(Some(watcher_handle)),
        shutdown_rx: shutdown_rx.clone(),
    });

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/tree", get(tree))
        .route("/api/file", get(get_file).put(put_file).delete(delete_file))
        .route("/api/file/rename", post(rename))
        .route("/api/file/mkdir", post(mkdir))
        .route("/api/events", get(sse))
        .route("/api/pair", post(pair))
        .route("/api/setup-pin", post(setup_pin))
        .route("/api/connect-info", get(connect_info))
        .route("/api/public-url", post(set_public_url))
        .route("/api/timed", get(timed_list))
        .fallback(static_fallback)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state.clone());

    let port = cfg.port;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                ApiError::PortInUse(port)
            } else {
                ApiError::internal(format!("listen 失败: {e}"))
            }
        })?;

    // timed 清扫器：随 shutdown 结束
    {
        let timed2 = timed.clone();
        let bus2 = bus.clone();
        let mut sd = shutdown_rx.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        let _ = timed2
                            .snapshot({
                                let b = bus2.clone();
                                move |_| {
                                    b.broadcast(BusEvent::TreeChanged);
                                }
                            })
                            .await;
                    }
                    _ = sd.changed() => break,
                }
            }
        });
    }

    let serve_state = state.clone();
    let mut shutdown_rx2 = shutdown_rx.clone();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx2.changed().await;
        })
        .await;
        // watcher 清理（drop 即停止监听）
        if let Ok(mut w) = serve_state.watcher.write() {
            drop(w.take());
        }
        let _ = done_tx.send(());
    });

    log::info!(
        "mdlive-rs 已启动 :{port} vault={} 配对码={}",
        cfg.vault,
        if cfg.token.is_empty() { "未设置" } else { "已设置" }
    );
    for ip in lan::lan_addresses() {
        log::info!("  局域网: http://{ip}:{port}");
    }

    Ok(RunningServer {
        port,
        vault: cfg.vault.clone(),
        shutdown_tx,
        done_rx,
    })
}

// ---------------- 鉴权 ----------------

fn extract_token(req: &Request) -> Option<String> {
    if let Some(auth) = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(raw) = auth.strip_prefix("Bearer ") {
            let decoded = percent_encoding::percent_decode_str(raw)
                .decode_utf8()
                .map(|s| s.to_string())
                .unwrap_or_else(|_| raw.to_string());
            return Some(decoded);
        }
    }
    if let Some(q) = req.uri().query() {
        for pair in q.split('&') {
            if let Some(v) = pair.strip_prefix("token=") {
                let decoded = percent_encoding::percent_decode_str(v)
                    .decode_utf8()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|_| v.to_string());
                return Some(decoded);
            }
        }
    }
    None
}

fn verify_token(expected: &str, got: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let a = hash::sha256_bytes(got);
    let b = hash::sha256_bytes(expected);
    hash::constant_time_eq(&a, &b)
}

async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = req.uri().path();
    if let Some(base) = path.strip_prefix("/api/") {
        let base = base.split('?').next().unwrap_or(base).trim_end_matches('/');
        if !matches!(base, "health" | "pair" | "setup-pin") {
            let token = extract_token(&req);
            let ok = token
                .and_then(|t| {
                    let expected = state.cfg.read().ok()?.token.clone();
                    Some(verify_token(&expected, &t))
                })
                .unwrap_or(false);
            if !ok {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({ "error": "unauthorized" })),
                )
                    .into_response();
            }
        }
    }
    next.run(req).await
}

// ---------------- handlers ----------------

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let cfg = state.cfg.read().unwrap();
    Json(serde_json::json!({
        "ok": true,
        "vault": cfg.vault,
        "version": env!("CARGO_PKG_VERSION"),
        "paired": !cfg.token.is_empty(),
    }))
}

async fn tree(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, ApiError> {
    let items = state.vault.tree().await?;
    Ok(Json(serde_json::json!({ "items": items })))
}

async fn get_file(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Some(p) = q.get("path") else {
        return Err(ApiError::bad("missing path"));
    };
    let f = state.vault.read(p).await?;
    Ok(Json(serde_json::json!({
        "content": f.content,
        "version": f.version,
        "mtime": f.mtime,
    })))
}

async fn put_file(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let path = body
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::bad("missing path"))?;
    let content = body.get("content").and_then(|v| v.as_str());
    let base_version = body
        .get("baseVersion")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let bus = state.bus.clone();
    let r = state
        .vault
        .write(path, content, &base_version, move |ev| {
            bus.broadcast(ev);
        })
        .await?;
    Ok(Json(serde_json::json!({
        "version": r.version,
        "mtime": r.mtime,
    })))
}

async fn delete_file(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Some(p) = q.get("path") else {
        return Err(ApiError::bad("missing path"));
    };
    state.vault.remove(p, |ev| state.bus.broadcast(ev)).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn rename(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let from = body
        .get("from")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::bad("from/to required"))?;
    let to = body
        .get("to")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::bad("from/to required"))?;
    state
        .vault
        .rename(from, to, |ev| state.bus.broadcast(ev))
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn mkdir(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let path = body
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::bad("missing path"))?;
    state.vault.mkdir(path, |ev| state.bus.broadcast(ev)).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn sse(
    State(state): State<Arc<AppState>>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, std::convert::Infallible>>>, ApiError> {
    let Some(slot) = state.bus.try_acquire_slot() else {
        return Err(ApiError::SseBusy);
    };
    let rx = state.bus.subscribe();
    let mut shutdown = state.shutdown_rx.clone();

    let stream = async_stream::stream! {
        let _slot = slot; // 连接存活期间占用名额
        yield Ok(Event::default().comment("hello"));
        let mut rx = rx;
        loop {
            tokio::select! {
                recv = rx.recv() => {
                    match recv {
                        Ok(ev) => yield Ok(to_sse(&ev)),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
                _ = shutdown.changed() => break, // 停服：立即断开全部 SSE 流
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::default()
            .interval(Duration::from_secs(25))
            .text("keepalive"),
    ))
}

fn to_sse(ev: &BusEvent) -> Event {
    match ev {
        BusEvent::FileChanged { path, version, mtime } => Event::default()
            .event("file-changed")
            .data(
                serde_json::json!({ "path": path, "version": version, "mtime": mtime })
                    .to_string(),
            ),
        BusEvent::FileRemoved { path } => Event::default()
            .event("file-removed")
            .data(serde_json::json!({ "path": path }).to_string()),
        BusEvent::TreeChanged => Event::default()
            .event("tree-changed")
            .data(serde_json::json!({}).to_string()),
    }
}

fn throttle(state: &AppState, ip: IpAddr) -> bool {
    let mut g = state.pair_attempts.write().unwrap();
    let now = Instant::now();
    match g.get_mut(&ip) {
        Some((n, t)) if now.duration_since(*t) < Duration::from_secs(60) => {
            *n += 1;
            *n > 10
        }
        _ => {
            g.insert(ip, (1, now));
            false
        }
    }
}

fn valid_code(code: &serde_json::Value) -> Option<String> {
    let s = code.as_str()?;
    let c = s.trim();
    // 按字符数计而非字节数，允许中文等多字节配对码
    if c.is_empty() || c.chars().count() > 128 || c.chars().any(|ch| (ch as u32) < 0x20) {
        return None;
    }
    Some(c.to_string())
}

async fn pair(
    State(state): State<Arc<AppState>>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if throttle(&state, addr.ip()) {
        return Err(ApiError::TooManyRequests);
    }
    let Some(code) = body.get("code").and_then(valid_code) else {
        return Err(ApiError::Unauthorized);
    };
    let token = state.cfg.read().unwrap().token.clone();
    if token.is_empty() || !verify_token(&token, &code) {
        return Err(ApiError::Unauthorized);
    }
    Ok(Json(serde_json::json!({ "token": token })))
}

async fn setup_pin(
    State(state): State<Arc<AppState>>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    {
        let cfg = state.cfg.read().unwrap();
        if !cfg.token.is_empty() || state.token_from_env {
            return Err(ApiError::Forbidden);
        }
    }
    if throttle(&state, addr.ip()) {
        return Err(ApiError::TooManyRequests);
    }
    let Some(code) = body.get("code").and_then(valid_code) else {
        return Err(ApiError::bad("配对码需为 1-128 个可见字符"));
    };
    {
        let mut cfg = state.cfg.write().unwrap();
        cfg.token = code.clone();
        (state.persist)(&cfg);
    }
    log::info!("配对码已在浏览器端设置完成");
    Ok(Json(serde_json::json!({ "token": code })))
}

async fn connect_info(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (token, port, public_url) = {
        let cfg = state.cfg.read().unwrap();
        (cfg.token.clone(), cfg.port, cfg.public_url.clone())
    };
    let lan: Vec<String> = lan::lan_addresses()
        .into_iter()
        .map(|ip| format!("http://{ip}:{port}"))
        .collect();
    // 公网/隧道地址优先（异网设备使用）
    let urls: Vec<String> = if public_url.is_empty() {
        lan
    } else {
        let mut v = vec![public_url.clone()];
        v.extend(lan);
        v
    };
    let mut qr: Option<String> = None;
    if let (Some(first), false) = (urls.first(), token.is_empty()) {
        let target = format!("{first}/?token={}", encode(&token));
        if let Ok(code) = qrcode::QrCode::new(target.as_bytes()) {
            let svg = code
                .render::<qrcode::render::svg::Color>()
                .dark_color(qrcode::render::svg::Color("#000000"))
                .light_color(qrcode::render::svg::Color("#ffffff"))
                .quiet_zone(true)
                .build();
            qr = Some(format!(
                "data:image/svg+xml;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
            ));
        }
    }
    Ok(Json(
        serde_json::json!({ "urls": urls, "qr": qr, "publicUrl": public_url }),
    ))
}

/// 校验公网（隧道）地址：http(s) 开头、无空白与危险字符、长度合理
fn validate_public_url(raw: &str) -> Option<String> {
    let u = raw.trim().trim_end_matches('/');
    if u.is_empty() {
        return Some(String::new()); // 空串 = 清除
    }
    if u.len() > 300 || !(u.starts_with("http://") || u.starts_with("https://")) {
        return None;
    }
    if u
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '\'' | '"' | '<' | '>' | '`'))
    {
        return None;
    }
    Some(u.to_string())
}

async fn set_public_url(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let raw = body.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let Some(url) = validate_public_url(raw) else {
        return Err(ApiError::bad("需要合法的 http(s) 地址"));
    };
    {
        let mut cfg = state.cfg.write().unwrap();
        cfg.public_url = url.clone();
        (state.persist)(&cfg);
    }
    if url.is_empty() {
        log::info!("已清除公网地址");
    } else {
        log::info!("公网地址已设置: {url}");
    }
    Ok(Json(serde_json::json!({ "ok": true, "publicUrl": url })))
}

async fn timed_list(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let bus = state.bus.clone();
    let tv = timed::TimedVault::new(state.vault.clone());
    let items = tv
        .snapshot(move |_| {
            bus.broadcast(BusEvent::TreeChanged);
        })
        .await;
    Ok(Json(serde_json::json!({ "items": items })))
}

async fn static_fallback(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> axum::response::Response {
    // 非 GET/HEAD 请求不提供 SPA fallback，直接 404
    let method = req.method().clone();
    let is_read = method == axum::http::Method::GET || method == axum::http::Method::HEAD;
    if !is_read {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not found" })),
        )
            .into_response();
    }
    // MDLIVE_WEB_DIST 外部目录优先（测试/覆盖场景），否则用内嵌资源
    if let Some(dir) = state.web_dist.clone() {
        let path = req.uri().path().trim_start_matches('/');
        let path = if path.is_empty() { "index.html" } else { path };
        let safe = crate::config::absolutize(&dir, path);
        if safe.starts_with(&dir) {
            if let Ok(bytes) = tokio::fs::read(&safe).await {
                let mime = static_files::mime_of(path);
                return (StatusCode::OK, [(header::CONTENT_TYPE, mime)], bytes).into_response();
            }
        }
        // SPA fallback
        if let Ok(bytes) = tokio::fs::read(dir.join("index.html")).await {
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                bytes,
            )
                .into_response();
        }
    }
    static_files::serve(req).await
}

use base64::Engine as _;

fn encode(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}
