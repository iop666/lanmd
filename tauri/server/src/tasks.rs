//! 任务单存储：vault/.lanmd/tasks.json。
//! 点目录与 .timed 同理——文件树与 watcher 都跳过「.」开头的目录，且随 vault 一起迁移。

use crate::error::ApiError;
use crate::events::{BusEvent, EventBus};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const MAX_ITEMS: usize = 500;
const TITLE_MAX: usize = 200;
const NOTE_MAX: usize = 2000;
const ACTOR_MAX: usize = 32;

/// 一条任务单：谁发起、谁确认、什么时候确认，都留在记录里
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    /// pending | done
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub created_by: String,
    #[serde(default)]
    pub created_by_id: String,
    pub done_at: Option<i64>,
    pub done_by: Option<String>,
    pub done_by_id: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Deserialize)]
struct StoreFile {
    #[serde(default)]
    items: Vec<TaskItem>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 去掉控制字符（保留换行/制表），去首尾空白，按字符上限截断
fn clean(v: &str, max: usize) -> String {
    let filtered: String = v
        .chars()
        .filter(|c| {
            let u = *c as u32;
            !(u < 0x09 || u == 0x0b || u == 0x0c || (0x0e..0x20).contains(&u) || u == 0x7f)
        })
        .collect();
    filtered.trim().chars().take(max).collect()
}

fn normalize(mut t: TaskItem) -> TaskItem {
    t.title = clean(&t.title, TITLE_MAX);
    t.note = clean(&t.note, NOTE_MAX);
    t.status = if t.status == "done" { "done".into() } else { "pending".into() };
    if t.created_by.is_empty() {
        t.created_by = "未署名".into();
    }
    if t.status == "pending" {
        t.done_at = None;
        t.done_by = None;
        t.done_by_id = None;
    }
    if t.updated_at == 0 {
        t.updated_at = t.created_at;
    }
    t
}

pub struct TaskStore {
    file: PathBuf,
    bus: EventBus,
    state: Mutex<Option<Vec<TaskItem>>>,
    seq: AtomicU64,
}

impl TaskStore {
    pub fn new(vault_root: &Path, bus: EventBus) -> Self {
        Self {
            file: vault_root.join(".lanmd").join("tasks.json"),
            bus,
            state: Mutex::new(None),
            seq: AtomicU64::new(0),
        }
    }

    fn new_id(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        crate::hash::sha12(&format!("{t}-{}-{n}", std::process::id()))
    }

    async fn ensure_locked(&self, guard: &mut Option<Vec<TaskItem>>) {
        if guard.is_some() {
            return;
        }
        let mut items: Vec<TaskItem> = Vec::new();
        if let Ok(raw) = tokio::fs::read_to_string(&self.file).await {
            let raw = raw.trim_start_matches('\u{feff}');
            match serde_json::from_str::<StoreFile>(raw) {
                Ok(f) => items = f.items.into_iter().map(normalize).collect(),
                Err(e) => log::error!("[tasks] tasks.json 解析失败，按空列表处理: {e}"),
            }
        }
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        *guard = Some(items);
    }

    async fn save_locked(&self, items: &[TaskItem]) -> Result<(), ApiError> {
        if let Some(dir) = self.file.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        let value = serde_json::json!({ "version": 1, "items": items });
        let body = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into()) + "\n";
        let tmp = self
            .file
            .with_extension(format!("json.tmp-{}", std::process::id()));
        tokio::fs::write(&tmp, body)
            .await
            .map_err(|e| ApiError::internal(format!("写 tasks.json 失败: {e}")))?;
        for attempt in 0..8u64 {
            match tokio::fs::rename(&tmp, &self.file).await {
                Ok(()) => return Ok(()),
                Err(_) if attempt < 7 => {
                    // Windows 上目标可能被杀软/索引短暂占用
                    tokio::time::sleep(std::time::Duration::from_millis(40 * (attempt + 1))).await;
                }
                Err(e) => {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return Err(ApiError::internal(format!("保存 tasks.json 失败: {e}")));
                }
            }
        }
        Ok(())
    }

    /// 超出上限时丢弃最老的一条已完成记录；没有已完成才丢最老的任务
    fn trim(items: &mut Vec<TaskItem>) {
        while items.len() > MAX_ITEMS {
            let idx = items
                .iter()
                .rposition(|x| x.status == "done")
                .unwrap_or(items.len() - 1);
            items.remove(idx);
        }
    }

    pub async fn list(&self) -> Vec<TaskItem> {
        let mut guard = self.state.lock().await;
        self.ensure_locked(&mut guard).await;
        guard.clone().unwrap_or_default()
    }

    pub async fn create(
        &self,
        title: &str,
        note: &str,
        actor: &str,
        actor_id: &str,
    ) -> Result<TaskItem, ApiError> {
        let title = clean(title, TITLE_MAX);
        if title.is_empty() {
            return Err(ApiError::bad("任务内容不能为空"));
        }
        let note = clean(note, NOTE_MAX);
        let actor = {
            let a = clean(actor, ACTOR_MAX);
            if a.is_empty() { "未署名".to_string() } else { a }
        };
        let actor_id = clean(actor_id, 64);

        let item = {
            let mut guard = self.state.lock().await;
            self.ensure_locked(&mut guard).await;
            let items = guard.as_mut().expect("ensured");
            let now = now_ms();
            let item = TaskItem {
                id: self.new_id(),
                title,
                note,
                status: "pending".into(),
                created_at: now,
                created_by: actor.clone(),
                created_by_id: actor_id,
                done_at: None,
                done_by: None,
                done_by_id: None,
                updated_at: now,
            };
            items.insert(0, item.clone());
            Self::trim(items);
            self.save_locked(items).await?;
            item
        };
        log::info!(
            "[tasks] 新增 {} by {}: {}",
            item.id,
            item.created_by,
            item.title.chars().take(40).collect::<String>()
        );
        self.bus.broadcast(BusEvent::TasksChanged);
        Ok(item)
    }

    /// 确认执行 / 撤销执行。同一状态重复提交是幂等的，不改时间戳
    pub async fn set_status(
        &self,
        id: &str,
        status: &str,
        actor: &str,
        actor_id: &str,
    ) -> Result<TaskItem, ApiError> {
        if id.is_empty() {
            return Err(ApiError::bad("缺少任务 id"));
        }
        if status != "pending" && status != "done" {
            return Err(ApiError::bad("status 只能是 pending 或 done"));
        }
        let actor = {
            let a = clean(actor, ACTOR_MAX);
            if a.is_empty() { "未署名".to_string() } else { a }
        };
        let actor_id = clean(actor_id, 64);

        let out = {
            let mut guard = self.state.lock().await;
            self.ensure_locked(&mut guard).await;
            let items = guard.as_mut().expect("ensured");
            let Some(pos) = items.iter().position(|x| x.id == id) else {
                return Err(ApiError::NotFound);
            };
            if items[pos].status == status {
                return Ok(items[pos].clone());
            }
            let now = now_ms();
            {
                let it = &mut items[pos];
                it.status = status.to_string();
                it.updated_at = now;
                if status == "done" {
                    it.done_at = Some(now);
                    it.done_by = Some(actor.clone());
                    it.done_by_id = Some(actor_id);
                } else {
                    it.done_at = None;
                    it.done_by = None;
                    it.done_by_id = None;
                }
            }
            self.save_locked(items).await?;
            items[pos].clone()
        };
        log::info!(
            "[tasks] {} {} by {}",
            if status == "done" { "确认" } else { "撤销" },
            out.id,
            actor
        );
        self.bus.broadcast(BusEvent::TasksChanged);
        Ok(out)
    }

    pub async fn remove(&self, id: &str) -> Result<(), ApiError> {
        if id.is_empty() {
            return Err(ApiError::bad("缺少任务 id"));
        }
        let removed = {
            let mut guard = self.state.lock().await;
            self.ensure_locked(&mut guard).await;
            let items = guard.as_mut().expect("ensured");
            let Some(pos) = items.iter().position(|x| x.id == id) else {
                return Err(ApiError::NotFound);
            };
            let gone = items.remove(pos);
            self.save_locked(items).await?;
            gone
        };
        log::info!("[tasks] 删除 {}", removed.id);
        self.bus.broadcast(BusEvent::TasksChanged);
        Ok(())
    }
}
