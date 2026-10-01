use crate::config::Config;
use crate::error::{ApiError, ApiResult};
use crate::events::BusEvent;
use crate::hash::sha12;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String, // "file" | "dir"
    pub mtime: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileData {
    pub content: String,
    pub version: String,
    pub mtime: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteResult {
    pub version: String,
    pub mtime: f64,
}

#[derive(Clone)]
enum PendingOp {
    Write { hash: String },
    Delete,
}

const PENDING_TTL: Duration = Duration::from_secs(3);

pub struct Vault {
    pub root: PathBuf,
    cfg: Arc<Config>,
    /// 回环抑制记录：本服务即将写盘的内容
    pending: Mutex<HashMap<String, (PendingOp, Instant)>>,
    /// 全局写互斥：同一时刻只做一个变更操作（消除 check-then-write 竞态）
    queue: Mutex<()>,
    is_windows: bool,
}

impl Vault {
    pub fn new(cfg: Arc<Config>, _bus: crate::events::EventBus) -> Self {
        let root = PathBuf::from(&cfg.vault);
        let _ = std::fs::create_dir_all(&root);
        Self {
            root,
            cfg,
            pending: Mutex::new(HashMap::new()),
            queue: Mutex::new(()),
            is_windows: cfg!(windows),
        }
    }

    fn norm_key(&self, p: &Path) -> String {
        let s = p.display().to_string();
        if self.is_windows {
            s.to_lowercase()
        } else {
            s
        }
    }

    /// watcher 用：ignore 名单匹配（win32 大小写不敏感）
    pub fn cfg_ignore_contains(&self, name: &str) -> bool {
        self.cfg.ignore.iter().any(|i| *i == name)
    }

    async fn mark_write(&self, abs: &Path, hash: &str) {
        let mut g = self.pending.lock().await;
        if g.len() > 256 {
            g.retain(|_, (_, at)| at.elapsed() < PENDING_TTL);
        }
        g.insert(self.norm_key(abs), (PendingOp::Write { hash: hash.to_string() }, Instant::now()));
    }

    async fn mark_delete(&self, abs: &Path) {
        let mut g = self.pending.lock().await;
        if g.len() > 256 {
            g.retain(|_, (_, at)| at.elapsed() < PENDING_TTL);
        }
        g.insert(self.norm_key(abs), (PendingOp::Delete, Instant::now()));
    }

    /// watcher 回调调用：判断是否本服务自己写盘的回声（3 秒窗口 + hash 匹配）
    pub async fn suppress_self(&self, abs: &Path, kind: &str, current_hash: Option<&str>) -> bool {
        let mut g = self.pending.lock().await;
        let key = self.norm_key(abs);
        let Some((op, at)) = g.get(&key) else {
            return false;
        };
        if at.elapsed() > PENDING_TTL {
            g.remove(&key);
            return false;
        }
        match op {
            PendingOp::Delete => kind == "unlink",
            PendingOp::Write { hash } => {
                if kind == "unlink" {
                    return false;
                }
                current_hash.is_some_and(|h| h == hash)
            }
        }
    }

    /// 校验并解析相对路径；任何逃逸尝试抛 400
    pub async fn resolve_safe(&self, rel: &str) -> ApiResult<PathBuf> {
        if rel.is_empty() || rel.len() > 1024 || rel.contains('\0') {
            return Err(ApiError::bad("bad path"));
        }
        if rel.contains('\\') {
            return Err(ApiError::bad("path must use / separators"));
        }
        if rel.starts_with('/') || (rel.len() >= 2 && rel.as_bytes()[1] == b':') {
            return Err(ApiError::bad("absolute path not allowed"));
        }
        let root_norm = normalize_path(&self.root);
        let candidate = crate::config::absolutize(&self.root, rel);
        let cand_norm = normalize_path(&candidate);
        // 归一化后必须仍在 root 内（且不是 root 本身）
        if !cand_norm.starts_with(&root_norm) || cand_norm == root_norm {
            return Err(ApiError::bad("path escapes vault"));
        }
        self.assert_inside_real(&cand_norm).await?;
        Ok(cand_norm)
    }

    /// realpath 包含性校验（拒绝符号链接/junction 逃逸）。路径不存在时逐级向上校验存在的最近祖先
    async fn assert_inside_real(&self, abs: &Path) -> ApiResult<()> {
        let root_real = match tokio::fs::canonicalize(&self.root).await {
            Ok(p) => normalize_path(&p),
            Err(_) => return Ok(()), // vault 无法解析时放弃该层检查
        };
        let mut probe = abs.to_path_buf();
        loop {
            match tokio::fs::canonicalize(&probe).await {
                Ok(real) => {
                    let real = normalize_path(&real);
                    if !real.starts_with(&root_real) {
                        return Err(ApiError::bad("symlink escapes vault"));
                    }
                    return Ok(());
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    match probe.parent() {
                        Some(p) if p != probe => probe = p.to_path_buf(),
                        _ => return Ok(()),
                    }
                }
                Err(e) => return Err(ApiError::internal(format!("realpath: {e}"))),
            }
        }
    }

    pub fn to_rel(&self, abs: &Path) -> String {
        let norm = normalize_path(abs);
        let root_norm = normalize_path(&self.root);
        let rel = norm
            .strip_prefix(&root_norm)
            .unwrap_or(&norm)
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        rel
    }

    pub async fn read(&self, rel: &str) -> ApiResult<FileData> {
        let abs = self.resolve_safe(rel).await?;
        let meta = tokio::fs::metadata(&abs)
            .await
            .map_err(|_| ApiError::NotFound)?;
        if !meta.is_file() {
            return Err(ApiError::NotFound);
        }
        let bytes = tokio::fs::read(&abs).await.map_err(|_| ApiError::NotFound)?;
        // 非法 UTF-8（如 GBK 老文件）以 U+FFFD 替换返回，对齐 Node 的容错解码
        let content = String::from_utf8_lossy(&bytes).to_string();
        let mtime = meta
            .modified()
            .ok()
            .and_then(stime_to_ms)
            .unwrap_or(0.0);
        Ok(FileData {
            version: sha12(&content),
            mtime,
            content,
        })
    }

    pub async fn write(
        &self,
        rel: &str,
        content: Option<&str>,
        base_version: &serde_json::Value,
        broadcast: impl Fn(BusEvent),
    ) -> ApiResult<WriteResult> {
        let Some(content) = content else {
            return Err(ApiError::bad("content must be a string"));
        };
        let content = content.to_string();
        let base_version: Option<String> = match base_version {
            serde_json::Value::Null => None,
            serde_json::Value::String(s) => Some(s.clone()),
            _ => return Err(ApiError::bad("baseVersion must be a string or null")),
        };
        let abs = self.resolve_safe(rel).await?;
        let _q = self.queue.lock().await; // 全局写互斥
        self.assert_inside_real(&abs).await?;

        let meta = tokio::fs::metadata(&abs).await.ok();
        if let Some(m) = &meta {
            if !m.is_file() {
                return Err(ApiError::bad("target is a directory"));
            }
        }
        let cur_version: Option<String> = if meta.is_some() {
            match tokio::fs::read(&abs).await {
                Ok(bytes) => Some(sha12(&String::from_utf8_lossy(&bytes))),
                Err(_) => return Err(ApiError::internal("read current failed")),
            }
        } else {
            None
        };

        match (&cur_version, &base_version) {
            (Some(cur), Some(base)) => {
                if cur != base {
                    let cur_content = tokio::fs::read(&abs)
                        .await
                        .map(|b| String::from_utf8_lossy(&b).to_string())
                        .unwrap_or_default();
                    return Err(ApiError::conflict(Some(cur), &cur_content));
                }
            }
            (Some(_), None) => {
                let cur_content = tokio::fs::read(&abs)
                    .await
                    .map(|b| String::from_utf8_lossy(&b).to_string())
                    .unwrap_or_default();
                return Err(ApiError::conflict(
                    Some(cur_version.as_deref().unwrap()),
                    &cur_content,
                ));
            }
            (None, Some(_)) => {
                // 想更新的文件已不存在（被外部删除）
                return Err(ApiError::conflict(None, ""));
            }
            (None, None) => {} // 新建 ✓
        }

        let version = sha12(&content);
        let relp = self.to_rel(&abs);
        // 父目录不存在则自动创建
        if let Some(parent) = abs.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ApiError::internal(format!("mkdir: {e}")))?;
        }
        self.mark_write(&abs, &version).await;
        let mtime = atomic_write(&abs, &content).await?;
        log::info!(" [write] {relp} -> {version}");
        broadcast(BusEvent::FileChanged {
            path: relp.clone(),
            version: version.clone(),
            mtime,
        });
        broadcast(BusEvent::TreeChanged);
        Ok(WriteResult { version, mtime })
    }

    pub async fn remove(&self, rel: &str, broadcast: impl Fn(BusEvent)) -> ApiResult<()> {
        let abs = self.resolve_safe(rel).await?;
        let _q = self.queue.lock().await;
        self.assert_inside_real(&abs).await?;
        let meta = tokio::fs::symlink_metadata(&abs)
            .await
            .map_err(|_| ApiError::NotFound)?;
        if !meta.is_file() {
            return Err(ApiError::bad("not a file"));
        }
        self.mark_delete(&abs).await;
        remove_with_retry(&abs).await?;
        let relp = self.to_rel(&abs);
        log::info!(" [delete] {relp}");
        broadcast(BusEvent::FileRemoved { path: relp });
        broadcast(BusEvent::TreeChanged);
        Ok(())
    }

    pub async fn rename(
        &self,
        from: &str,
        to: &str,
        broadcast: impl Fn(BusEvent),
    ) -> ApiResult<()> {
        let from_abs = self.resolve_safe(from).await?;
        let to_abs = self.resolve_safe(to).await?;
        let _q = self.queue.lock().await;
        if from_abs == to_abs {
            return Ok(());
        }
        self.assert_inside_real(&from_abs).await?;
        self.assert_inside_real(&to_abs).await?;
        let st = tokio::fs::symlink_metadata(&from_abs)
            .await
            .map_err(|_| ApiError::NotFound)?;
        if !st.is_file() {
            return Err(ApiError::bad("source is not a file"));
        }
        if tokio::fs::symlink_metadata(&to_abs).await.is_ok() {
            return Err(ApiError::Conflict {
                payload: serde_json::json!({ "error": "target exists" }),
            });
        }
        let content_bytes = tokio::fs::read(&from_abs)
            .await
            .map_err(|e| ApiError::internal(format!("read: {e}")))?;
        let content = String::from_utf8_lossy(&content_bytes).to_string();
        let hash = sha12(&content);
        if let Some(parent) = to_abs.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ApiError::internal(format!("mkdir: {e}")))?;
        }
        self.mark_delete(&from_abs).await;
        self.mark_write(&to_abs, &hash).await;
        tokio::fs::rename(&from_abs, &to_abs)
            .await
            .map_err(|e| ApiError::internal(format!("rename: {e}")))?;
        let rel_from = self.to_rel(&from_abs);
        let rel_to = self.to_rel(&to_abs);
        log::info!(" [rename] {rel_from} -> {rel_to}");
        broadcast(BusEvent::FileRemoved { path: rel_from });
        let mtime = tokio::fs::metadata(&to_abs)
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(stime_to_ms)
            .unwrap_or(0.0);
        broadcast(BusEvent::FileChanged {
            path: rel_to,
            version: hash,
            mtime,
        });
        broadcast(BusEvent::TreeChanged);
        Ok(())
    }

    pub async fn mkdir(&self, rel: &str, broadcast: impl Fn(BusEvent)) -> ApiResult<()> {
        let abs = self.resolve_safe(rel).await?;
        let _q = self.queue.lock().await;
        self.assert_inside_real(&abs).await?;
        match tokio::fs::symlink_metadata(&abs).await {
            Ok(m) if m.is_dir() => return Ok(()), // 幂等
            Ok(_) => {
                return Err(ApiError::Conflict {
                    payload: serde_json::json!({ "error": "a file with this name already exists" }),
                })
            }
            Err(_) => {}
        }
        tokio::fs::create_dir_all(&abs)
            .await
            .map_err(|e| ApiError::internal(format!("mkdir: {e}")))?;
        log::info!(" [mkdir] {}", self.to_rel(&abs));
        broadcast(BusEvent::TreeChanged);
        Ok(())
    }

    pub async fn tree(&self) -> ApiResult<Vec<TreeNode>> {
        let ignore: Vec<String> = self
            .cfg
            .ignore
            .iter()
            .map(|n| if self.is_windows { n.to_lowercase() } else { n.clone() })
            .collect();
        self.walk(&self.root, "", &ignore).await
    }

    fn walk<'a>(
        &'a self,
        dir: &'a Path,
        rel_dir: &'a str,
        ignore: &'a [String],
    ) -> impl Future<Output = ApiResult<Vec<TreeNode>>> + Send + 'a {
        async move {
            let mut entries = match tokio::fs::read_dir(dir).await {
                Ok(rd) => rd,
                Err(_) => return Ok(vec![]),
            };
            let mut out: Vec<TreeNode> = Vec::new();
            let mut pending_dirs: Vec<(String, PathBuf)> = Vec::new();
            while let Ok(Some(e)) = entries.next_entry().await {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let abs = e.path();
                let ft = match e.file_type().await {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let rel = if rel_dir.is_empty() {
                    name.clone()
                } else {
                    format!("{rel_dir}/{name}")
                };
                if ft.is_dir() {
                    let key = if self.is_windows { name.to_lowercase() } else { name.clone() };
                    if ignore.iter().any(|i| *i == key) {
                        continue;
                    }
                    pending_dirs.push((rel, abs));
                } else if ft.is_file() && name.to_lowercase().ends_with(".md") {
                    let mtime = e
                        .metadata()
                        .await
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(stime_to_ms)
                        .unwrap_or(0.0);
                    out.push(TreeNode {
                        name,
                        path: rel,
                        kind: "file".into(),
                        mtime,
                        children: None,
                    });
                }
            }
            for (rel, abs) in pending_dirs {
                let children = Box::pin(self.walk(&abs, &rel, ignore)).await?;
                out.push(TreeNode {
                    name: rel.rsplit('/').next().unwrap_or(&rel).to_string(),
                    path: rel,
                    kind: "dir".into(),
                    mtime: 0.0,
                    children: Some(children),
                });
            }
            // 文件排前，目录按名称排
            out.sort_by(|a, b| {
                if a.kind != b.kind {
                    if a.kind == "file" {
                        std::cmp::Ordering::Less
                    } else {
                        std::cmp::Ordering::Greater
                    }
                } else {
                    a.name.cmp(&b.name)
                }
            });
            Ok(out)
        }
    }
}

use std::future::Future;

fn stime_to_ms(t: SystemTime) -> Option<f64> {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64() * 1000.0)
}

/// 词法归一化：消解 . / ..；Windows 下统一大小写盘符（不做文件系统访问）
pub fn normalize_path(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut parts: Vec<Component> = Vec::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = match parts.last() {
                    Some(Component::Normal(_)) | Some(Component::ParentDir) => true,
                    _ => false,
                };
                if can_pop {
                    parts.pop();
                }
            }
            other => parts.push(other),
        }
    }
    parts.iter().collect()
}

/// 原子写：tmp + rename；Windows 上 rename 遇 EPERM/EACCES 小退避重试
async fn atomic_write(abs: &Path, content: &str) -> ApiResult<f64> {
    use rand::Rng;
    let tmp_name = format!(
        "{}.tmp-{}-{}",
        abs.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        rand::thread_rng().gen::<u32>()
    );
    let tmp = abs.parent().unwrap_or(Path::new(".")).join(tmp_name);
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| ApiError::internal(format!("write tmp: {e}")))?;
    let mut attempt = 0u32;
    loop {
        match tokio::fs::rename(&tmp, abs).await {
            Ok(_) => break,
            Err(e) if attempt < 8 && matches!(e.kind(), std::io::ErrorKind::PermissionDenied) => {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(40 * attempt as u64)).await;
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(ApiError::internal(format!("rename: {e}")));
            }
        }
    }
    let mtime = tokio::fs::metadata(abs)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(stime_to_ms)
        .unwrap_or(0.0);
    Ok(mtime)
}

async fn remove_with_retry(abs: &Path) -> ApiResult<()> {
    let mut attempt = 0u32;
    loop {
        match tokio::fs::remove_file(abs).await {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ApiError::NotFound),
            Err(e) if attempt < 8 && matches!(e.kind(), std::io::ErrorKind::PermissionDenied) => {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(40 * attempt as u64)).await;
            }
            Err(e) => return Err(ApiError::internal(format!("rm: {e}"))),
        }
    }
}
