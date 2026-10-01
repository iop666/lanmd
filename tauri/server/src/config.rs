use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
pub struct Config {
    pub vault: String,
    pub port: u16,
    pub token: String,
    pub ignore: Vec<String>,
}

pub struct LoadedConfig {
    pub cfg: Config,
    /// 把当前配置写回 config.json（保留文件里的未知字段）
    pub persist: Arc<dyn Fn(&Config) + Send + Sync>,
}

fn gen_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..8).map(|_| format!("{:x}", rng.gen::<u8>() & 0xf)).collect()
}

/// data_dir：config.json 与默认 vault 所在目录。
/// 环境变量 MDLIVE_VAULT / MDLIVE_PORT / MDLIVE_TOKEN 覆盖（设置 MDLIVE_VAULT 时为无文件模式，不读写 config.json）
pub fn load_config(data_dir: &Path) -> LoadedConfig {
    let env_vault = std::env::var("MDLIVE_VAULT").ok().filter(|v| !v.is_empty());
    let no_file_mode = env_vault.is_some();
    let cfg_path = data_dir.join("config.json");

    let mut cfg = Config {
        vault: data_dir.join("vault").display().to_string(),
        port: 8787,
        token: String::new(),
        ignore: vec![
            ".git".into(),
            ".obsidian".into(),
            "node_modules".into(),
            ".trash".into(),
        ],
    };
    let extra: Arc<Mutex<serde_json::Value>> = Arc::new(Mutex::new(serde_json::Value::Null));
    let mut file_exists = false;
    let mut file_mtime: Option<std::time::SystemTime> = None;

    if env_vault.is_none() {
        if let Ok(raw) = fs::read_to_string(&cfg_path) {
            let raw = raw.trim_start_matches('\u{feff}');
            file_exists = cfg_path.exists();
            file_mtime = fs::metadata(&cfg_path).ok().map(|m| m.modified().ok()).flatten();
            match serde_json::from_str::<serde_json::Value>(raw) {
                Ok(v) => {
                    if let Some(vault) = v.get("vault").and_then(|x| x.as_str()) {
                        if !vault.is_empty() {
                            cfg.vault = absolutize(data_dir, vault).display().to_string();
                        }
                    }
                    if let Some(port) = v.get("port").and_then(|x| x.as_u64()) {
                        cfg.port = u16::try_from(port).unwrap_or_else(|_| {
                            eprintln!(
                                "[warn] config.json 的 port={port} 超出 1-65535，已回退默认 8787"
                            );
                            8787
                        });
                    }
                    if let Some(token) = v.get("token").and_then(|x| x.as_str()) {
                        cfg.token = token.to_string();
                    }
                    if let Some(ignore) = v.get("ignore").and_then(|x| x.as_array()) {
                        // 尊重空数组（用户可清空忽略列表）
                        cfg.ignore = ignore
                            .iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect();
                    }
                    *extra.lock().unwrap() = v;
                }
                Err(e) => log::warn!(" config.json 解析失败，使用默认配置: {e}"),
            }
        } else {
            file_exists = false;
            // 首次启动：生成默认配置（token 留空，待浏览器端设置配对码）
            let _ = fs::create_dir_all(data_dir.join("vault"));
            persist_inner(&cfg_path, &cfg, &extra);
            log::info!(" 首次启动，已生成配置 {}", cfg_path.display());
        }
    }

    if let Some(v) = &env_vault {
        cfg.vault = absolutize(Path::new("."), v).display().to_string();
    }
    if let Ok(p) = std::env::var("MDLIVE_PORT") {
        if let Ok(p) = p.parse::<u16>() {
            cfg.port = p;
        }
    }
    if let Ok(t) = std::env::var("MDLIVE_TOKEN") {
        if !t.is_empty() {
            cfg.token = t;
        }
    }
    let _ = fs::create_dir_all(Path::new(&cfg.vault));

    let persist_dir = data_dir.to_path_buf();
    let persist_extra = extra.clone();
    let persist_no_file = no_file_mode;
    let persist = Arc::new(move |c: &Config| {
        if persist_no_file {
            return; // 无文件模式下所有配置变更仅保留在内存中
        }
        persist_inner(&persist_dir.join("config.json"), c, &persist_extra);
    });

    LoadedConfig { cfg, persist }
}

fn persist_inner(cfg_path: &Path, cfg: &Config, extra: &Mutex<serde_json::Value>) {
    let mut base = match extra.lock() {
        Ok(g) if g.is_object() => g.clone(),
        _ => serde_json::json!({}),
    };
    let obj = base.as_object_mut().unwrap();
    obj.insert("vault".into(), serde_json::json!(cfg.vault));
    obj.insert("port".into(), serde_json::json!(cfg.port));
    obj.insert("token".into(), serde_json::json!(cfg.token));
    obj.insert("ignore".into(), serde_json::json!(cfg.ignore));
    let out = serde_json::to_string_pretty(&base).unwrap_or_default();
    let _ = fs::write(cfg_path, out + "\n");
}

/// 相对 data_dir 的路径转绝对路径（词法归一化，等价 Node.js path.resolve 语义）
pub fn absolutize(base: &Path, rel: &str) -> PathBuf {
    let joined = if Path::new(rel).is_absolute() {
        PathBuf::from(rel)
    } else {
        base.join(rel)
    };
    normalize(&joined)
}

/// 词法归一化（不触碰文件系统）：消解 . 与 ..，保留根
pub fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut parts: Vec<Component> = Vec::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                // 弹掉上一段（保留根/前缀）
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_dots() {
        let base = Path::new("D:\\data");
        assert_eq!(
            absolutize(base, "a/../b.md").display().to_string(),
            "D:\\data\\b.md"
        );
        assert_eq!(
            absolutize(base, "../../x").display().to_string(),
            "D:\\x"
        );
    }
}
