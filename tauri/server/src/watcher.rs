use crate::events::BusEvent;
use crate::hash::sha12;
use crate::vault::Vault;
use notify::Watcher;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

const DEBOUNCE_MS: u64 = 200;
const STABILITY_MS: u64 = 300;

pub struct WatcherHandle {
    /// drop 即停止监听
    _inner: notify::RecommendedWatcher,
}

/// 启动 notify 监听：ignoreInitial（不回放现有文件）、去抖 200ms、写稳定窗 300ms、
/// 回环抑制（vault.pending）、点开头/ignore/tmp- 过滤
pub fn start(vault: Arc<Vault>, bus: crate::events::EventBus) -> Result<WatcherHandle, notify::Error> {
    let (tx, mut rx) = mpsc::unbounded_channel::<(PathBuf, String)>();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(ev) = res {
            // notify 的 rename 语义：Name(From)=旧路径消失（按 unlink）、Name(To)=新路径出现（按 add）、
            // Name(Both) paths=[旧, 新] 两段。不区分会导致改名后旧路径的 file-removed 丢失。
            use notify::event::{ModifyKind, RenameMode};
            eprintln!("[debug] RAW EVENT kind={:?} paths={:?}", ev.kind, ev.paths);
            let events: Vec<(PathBuf, &str)> = match &ev.kind {
                notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                    ev.paths.iter().map(|p| (p.clone(), "unlink")).collect()
                }
                notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                    ev.paths.iter().map(|p| (p.clone(), "add")).collect()
                }
                notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                    // paths[0]=旧名（unlink），paths[1]=新名（add）
                    let mut v = Vec::new();
                    if let Some(from) = ev.paths.first() {
                        v.push((from.clone(), "unlink"));
                    }
                    if let Some(to) = ev.paths.get(1) {
                        v.push((to.clone(), "add"));
                    }
                    v
                }
                notify::EventKind::Create(_) => ev.paths.iter().map(|p| (p.clone(), "add")).collect(),
                notify::EventKind::Modify(_) => ev.paths.iter().map(|p| (p.clone(), "change")).collect(),
                notify::EventKind::Remove(_) => ev.paths.iter().map(|p| (p.clone(), "unlink")).collect(),
                _ => return,
            };
            for (p, kind) in events {
                let _ = tx.send((p, kind.to_string()));
            }
        }
    })?;
    watcher.watch(Path::new(vault.root.as_path()), notify::RecursiveMode::Recursive)?;

    let root = vault.root.clone();
    tokio::spawn(async move {
        // path -> 去抖定时任务句柄
        let mut timers: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        loop {
            tokio::select! {
                item = rx.recv() => {
                    let Some((path, kind)) = item else { break };
                    if is_ignored(&vault, &path) {
                        continue;
                    }
                    let key = path.display().to_string().to_lowercase();
                    if let Some(existing) = timers.remove(&key) {
                        existing.abort();
                    }
                    let v = vault.clone();
                    let b = bus.clone();
                    let p = path.clone();
                    let k = kind.clone();
                    timers.insert(
                        key.clone(),
                        tokio::spawn(async move {
                            // 去抖 + 写稳定窗口合一
                            tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS.max(STABILITY_MS))).await;
                            if k == "unlink" {
                                handle_unlink(&v, &b, &p).await;
                            } else {
                                handle_upsert(&v, &b, &p).await;
                            }
                        }),
                    );
                }
                _ = interval.tick() => {
                    // 清理已完成的定时任务句柄，防 map 无限增长
                    timers.retain(|_, h| !h.is_finished());
                }
            }
        }
    });

    Ok(WatcherHandle {
        _inner: watcher,
    })
}

use std::collections::HashMap;

async fn is_directory(p: &Path) -> bool {
    tokio::fs::metadata(p)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false)
}

fn is_ignored(vault: &Arc<Vault>, p: &Path) -> bool {
    let root = &vault.root;
    let Ok(rel) = p.strip_prefix(root) else { return true };
    let segs: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    if segs.is_empty() {
        return false;
    }
    let ci = cfg!(windows);
    for s in &segs {
        if s.starts_with('.') {
            return true;
        }
        let key = if ci { s.to_lowercase() } else { s.clone() };
        if vault.cfg_ignore_contains(&key) {
            return true;
        }
    }
    if let Some(last) = segs.last() {
        if last.contains(".tmp-") {
            return true;
        }
    }
    false
}

async fn handle_upsert(vault: &Arc<Vault>, bus: &crate::events::EventBus, abs: &Path) {
    let name = abs.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if is_directory(abs).await {
        // 目录改名/新增：递归广播其下全部 .md（M3：目录 rename 时 notify 只报目录事件）
        if let Ok(mut rd) = tokio::fs::read_dir(abs).await {
            while let Ok(Some(e)) = rd.next_entry().await {
                Box::pin(handle_upsert(vault, bus, &e.path())).await;
            }
        }
        return;
    }
    if !name.to_lowercase().ends_with(".md") {
        return;
    }
    let content = match tokio::fs::read_to_string(abs).await {
        Ok(c) => c,
        Err(_) => return, // 事件到达时文件已消失，等 unlink
    };
    let hash = sha12(&content);
    if vault.suppress_self(abs, "change", Some(&hash)).await {
        log::debug!(" [watcher] 丢弃自身写盘回声: {} ({hash})", vault.to_rel(abs));
        return;
    }
    let mtime = tokio::fs::metadata(abs)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::SystemTime::UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0);
    log::info!(" [watcher] 外部修改: {} -> {hash}", vault.to_rel(abs));
    bus.broadcast(BusEvent::FileChanged {
        path: vault.to_rel(abs),
        version: hash,
        mtime,
    });
    bus.broadcast(BusEvent::TreeChanged);
}

async fn handle_unlink(vault: &Arc<Vault>, bus: &crate::events::EventBus, abs: &Path) {
    let name = abs.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if is_directory(abs).await {
        // 旧目录已被移走无法列举；其下文件无事件可发——由 tree-changed 兜底刷新树。
        // 这里仅对最后一个已知情形（.md 目录本身）发 removed
        if name.to_lowercase().ends_with(".md") {
            bus.broadcast(BusEvent::FileRemoved { path: vault.to_rel(abs) });
        }
        bus.broadcast(BusEvent::TreeChanged);
        return;
    }
    if !name.to_lowercase().ends_with(".md") {
        return;
    }
    if vault.suppress_self(abs, "unlink", None).await {
        log::debug!(" [watcher] 丢弃自身删除回声: {}", vault.to_rel(abs));
        return;
    }
    log::info!(" [watcher] 外部删除: {}", vault.to_rel(abs));
    bus.broadcast(BusEvent::FileRemoved { path: vault.to_rel(abs) });
    bus.broadcast(BusEvent::TreeChanged);
}
