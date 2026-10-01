//! 极简文件日志：log facade → logs/server.log（>5MB 轮转 .old）
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

struct Inner {
    file: Option<File>,
    path: PathBuf,
    bytes: usize,
}

static LOGGER: OnceLock<Mutex<Inner>> = OnceLock::new();

pub fn init(path: &PathBuf) {
    if LOGGER.get().is_some() {
        return;
    }
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(PathBuf::new().as_path()));
    let bytes = std::fs::metadata(path).map(|m| m.len() as usize).unwrap_or(0);
    let inner = Inner {
        file: open_append(path),
        path: path.clone(),
        bytes,
    };
    let _ = LOGGER.set(Mutex::new(inner));
    let _ = log::set_logger(&BRIDGE);
    log::set_max_level(log::LevelFilter::Info);
}

fn open_append(path: &PathBuf) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(path).ok()
}

struct Bridge;

impl log::Log for Bridge {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        let Some(mutex) = LOGGER.get() else { return };
        let mut guard = mutex.lock().unwrap();
        use chrono::Timelike;
        let now = chrono::Local::now();
        let line = format!(
            "[{:02}:{:02}:{:02}] [{}] {}\n",
            now.hour(),
            now.minute(),
            now.second(),
            record.level().to_string().to_lowercase(),
            record.args()
        );
        if let Some(f) = guard.file.as_mut() {
            let _ = f.write_all(line.as_bytes());
            guard.bytes += line.len();
            if guard.bytes > 5 * 1024 * 1024 {
                // 轮转：server.log -> server.log.old
                guard.file = None;
                let old = guard.path.with_extension("log.old");
                let _ = std::fs::remove_file(&old);
                let _ = std::fs::rename(&guard.path, &old);
                guard.file = open_append(&guard.path);
                guard.bytes = 0;
            }
        }
    }

    fn flush(&self) {}
}

static BRIDGE: Bridge = Bridge;
