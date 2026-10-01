/// 便携路径解析（Tauri 版）：
/// - 数据目录 = exe 所在目录/Lanmd-data（Tauri exe 是普通单文件，无 %TEMP% 解压）
/// - exe 目录不可写（只读位置）→ 回退 %APPDATA%/lanmd-tauri，由外壳气泡告知
use std::path::PathBuf;

pub fn resolve_data_dir() -> PathBuf {
    let base = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let preferred = base.join("Lanmd-data");
    let probe = preferred.join(format!(".write-probe-{}", std::process::id()));
    let can_write = std::fs::create_dir_all(&preferred).is_ok()
        && std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    if can_write {
        return preferred;
    }
    let fallback = std::env::var("APPDATA")
        .map(|d| PathBuf::from(d).join("lanmd-tauri"))
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}
