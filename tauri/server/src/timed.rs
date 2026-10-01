use crate::events::BusEvent;
use crate::vault::Vault;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const MIN: u64 = 60_000;

#[derive(Debug, Clone)]
pub struct TimedSlotDef {
    pub id: &'static str,
    pub label: &'static str,
    pub duration_ms: u64,
}

pub const TIMED_SLOTS: [TimedSlotDef; 6] = [
    TimedSlotDef { id: "1h-1", label: "1小时·A", duration_ms: 60 * MIN },
    TimedSlotDef { id: "1h-2", label: "1小时·B", duration_ms: 60 * MIN },
    TimedSlotDef { id: "30m-1", label: "30分钟·A", duration_ms: 30 * MIN },
    TimedSlotDef { id: "30m-2", label: "30分钟·B", duration_ms: 30 * MIN },
    TimedSlotDef { id: "10m-1", label: "10分钟·A", duration_ms: 10 * MIN },
    TimedSlotDef { id: "10m-2", label: "10分钟·B", duration_ms: 10 * MIN },
];

#[derive(Debug, Clone, Serialize)]
pub struct TimedSlotInfo {
    pub id: String,
    pub label: String,
    pub path: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    pub exists: bool,
    #[serde(rename = "remainingMs")]
    pub remaining_ms: Option<u64>,
    pub mtime: Option<f64>,
    pub size: Option<u64>,
}

pub struct TimedVault {
    vault: Arc<Vault>,
}

impl TimedVault {
    pub fn new(vault: Arc<Vault>) -> Self {
        Self { vault }
    }

    pub fn slot_path(&self, id: &str) -> PathBuf {
        self.vault.root.join(".timed").join(format!("{id}.md"))
    }

    /// 快照 + 到期删除
    pub async fn snapshot(&self, on_delete: impl Fn(PathBuf)) -> Vec<TimedSlotInfo> {
        let dir = self.vault.root.join(".timed");
        let _ = tokio::fs::create_dir_all(&dir).await;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let mut out = Vec::new();
        for def in TIMED_SLOTS.iter() {
            let abs = dir.join(format!("{}.md", def.id));
            let rel = format!(".timed/{}.md", def.id);
            match tokio::fs::metadata(&abs).await {
                Ok(m) if m.is_file() => {
                    let mtime_ms = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs_f64() * 1000.0)
                        .unwrap_or(0.0);
                    let remain = mtime_ms + def.duration_ms as f64 - now_ms;
                    if remain <= 0.0 {
                        self.remove_expired(&abs, def.label).await;
                        on_delete(abs);
                        out.push(TimedSlotInfo {
                            id: def.id.into(),
                            label: def.label.into(),
                            path: rel,
                            duration_ms: def.duration_ms,
                            exists: false,
                            remaining_ms: None,
                            mtime: None,
                            size: None,
                        });
                    } else {
                        out.push(TimedSlotInfo {
                            id: def.id.into(),
                            label: def.label.into(),
                            path: rel,
                            duration_ms: def.duration_ms,
                            exists: true,
                            remaining_ms: Some(remain as u64),
                            mtime: Some(mtime_ms),
                            size: Some(m.len()),
                        });
                    }
                }
                _ => {
                    out.push(TimedSlotInfo {
                        id: def.id.into(),
                        label: def.label.into(),
                        path: rel,
                        duration_ms: def.duration_ms,
                        exists: false,
                        remaining_ms: None,
                        mtime: None,
                        size: None,
                    });
                }
            }
        }
        out
    }

    async fn remove_expired(&self, abs: &PathBuf, label: &str) {
        let mut attempt = 0u32;
        loop {
            match tokio::fs::remove_file(abs).await {
                Ok(_) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
                Err(e)
                    if attempt < 4
                        && e.kind() == std::io::ErrorKind::PermissionDenied =>
                {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(50 * attempt as u64)).await;
                }
                Err(e) => {
                    log::error!(" [timed] 删除过期槽失败 {label}: {e}");
                    return;
                }
            }
        }
        log::info!(" [timed] 到期自动删除: {label}");
    }

    pub fn spawn_sweeper(self: Arc<Self>, bus: crate::events::EventBus) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            loop {
                interval.tick().await;
                let bus2 = bus.clone();
                let _ = self
                    .snapshot(move |_| {
                        bus2.broadcast(BusEvent::TreeChanged);
                    })
                    .await;
            }
        });
    }
}
