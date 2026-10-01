use serde::Serialize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum BusEvent {
    FileChanged { path: String, version: String, mtime: f64 },
    FileRemoved { path: String },
    TreeChanged,
}

const CHANNEL_CAP: usize = 256;
pub const MAX_CLIENTS: usize = 64;

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<BusEvent>,
    count: Arc<AtomicUsize>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(CHANNEL_CAP);
        Self {
            tx,
            count: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn broadcast(&self, ev: BusEvent) {
        let kind = match &ev {
            BusEvent::FileChanged { path, .. } => format!("file-changed {path}"),
            BusEvent::FileRemoved { path } => format!("file-removed {path}"),
            BusEvent::TreeChanged => "tree-changed".into(),
        };
        eprintln!("[info] [sse] 广播 {kind}");
        // 无订阅者时 send 返回 Err，正常忽略
        let _ = self.tx.send(ev);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BusEvent> {
        self.tx.subscribe()
    }

    pub fn try_acquire_slot(&self) -> Option<SseSlotGuard> {
        let cur = self.count.load(Ordering::SeqCst);
        if cur >= MAX_CLIENTS {
            return None;
        }
        // CAS 防并发略超上限
        if self
            .count
            .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return self.try_acquire_slot();
        }
        Some(SseSlotGuard {
            count: self.count.clone(),
        })
    }
}

pub struct SseSlotGuard {
    count: Arc<AtomicUsize>,
}

impl Drop for SseSlotGuard {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::SeqCst);
    }
}
