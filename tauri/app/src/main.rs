//! GUI 入口：托盘 + 内嵌 Rust 服务（同进程 tokio 任务，无子进程）。
//! 无任何 BrowserWindow / WebView 实例——系统托盘是唯一 UI。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod file_logger;
mod paths;

use file_logger::init as file_logger_init;
use lanmd_server::StartOpts;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

struct ServerState(Mutex<Option<lanmd_server::RunningServer>>);

const ICON_NORMAL: &[u8] = include_bytes!("../icons/icon-tray-32.png");
const ICON_WARN: &[u8] = include_bytes!("../icons/icon-tray-warn-32.png");

fn main() {
    let data_dir = paths::resolve_data_dir();
    let _ = std::fs::create_dir_all(data_dir.join("vault"));
    let _ = std::fs::create_dir_all(data_dir.join("logs"));
    file_logger_init(&data_dir.join("logs").join("server.log"));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二个实例：打开已有实例的页面
            open_lanmd(app);
            let _ = app.notification().builder().title("Lanmd 已在运行").body("已为你打开页面").show();
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .manage(ServerState(Mutex::new(None)))
        .manage(DataDir(data_dir.clone()))
        .setup(move |app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            start_service(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running lanmd tray application");
}

#[derive(Clone)]
struct DataDir(PathBuf);

impl std::ops::Deref for DataDir {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}

fn open_lanmd(app: &AppHandle) {
    let state: tauri::State<ServerState> = app.state();
    let guard = state.0.lock().unwrap();
    if let Some(s) = guard.as_ref() {
        let _ = open::that(format!("http://localhost:{}", s.port));
    } else {
        drop(guard);
        let _ = app.notification().builder().title("Lanmd 未运行").body("右键托盘图标可重试启动").show();
    }
}

fn start_service(app: &AppHandle) {
    let handle = app.clone();
    let data_dir: PathBuf = app.state::<DataDir>().0.clone();
    tauri::async_runtime::spawn(async move {
        match lanmd_server::start_server(StartOpts {
            data_dir: data_dir.clone(),
            web_dist: None,
        })
        .await
        {
            Ok(server) => {
                log::info!("服务已启动 :{}", server.port);
                {
                    let state: tauri::State<ServerState> = handle.state();
                    *state.0.lock().unwrap() = Some(server);
                }
                set_tray_icon(&handle, true);
                let _ = handle.notification().builder().title("Lanmd 已启动").body("点击托盘图标打开").show();
            }
            Err(e) => {
                let msg = match &e {
                    lanmd_server::ApiError::PortInUse(p) => format!("端口 {p} 被占用"),
                    other => format!("{other:?}"),
                };
                log::error!("服务启动失败: {msg}");
                set_tray_icon(&handle, false);
                let _ = handle.notification().builder().title("Lanmd 启动失败").body(format!("{msg}（右键托盘可重试）")).show();
            }
        }
    });
}

fn restart_service(app: &AppHandle) {
    let handle = app.clone();
    set_tray_icon(app, false);
    tauri::async_runtime::spawn(async move {
        {
            let state: tauri::State<ServerState> = handle.state();
            let old = state.0.lock().unwrap().take();
            if let Some(old) = old {
                old.stop().await;
            }
        }
        start_service(&handle);
    });
}

fn set_tray_icon(app: &AppHandle, ok: bool) {
    let bytes = if ok { ICON_NORMAL } else { ICON_WARN };
    if let Ok(img) = tauri::image::Image::from_bytes(bytes) {
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_icon(Some(img));
            let tip: String = if ok { "Lanmd · 联墨　运行中".into() } else { "Lanmd · 联墨　服务异常".into() };
            let _ = tray.set_tooltip(Some(tip));
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Lanmd", true, None::<&str>)?;
    let copy = MenuItem::with_id(app, "copy", "复制局域网地址", true, None::<&str>)?;
    let vault = MenuItem::with_id(app, "vault", "打开笔记库文件夹", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "打开数据文件夹", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "查看日志", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "服务状态：启动中…", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&copy)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&vault)
        .item(&data)
        .item(&logs)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&status)
        .item(&restart)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&quit)
        .build()?;

    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(ICON_WARN)?)
        .tooltip("Lanmd · 联墨　启动中…")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_lanmd(app),
            "copy" => copy_lan_url(app),
            "vault" => open_subdir(app, "vault"),
            "data" => open_subdir(app, "data"),
            "logs" => open_subdir(app, "logs"),
            "restart" => restart_service(app),
            "quit" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state: tauri::State<ServerState> = handle.state();
                    let s = state.0.lock().unwrap().take();
                    if let Some(s) = s {
                        s.stop().await;
                    }
                    handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_lanmd(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn copy_lan_url(app: &AppHandle) {
    let data_dir: PathBuf = app.state::<DataDir>().0.clone();
    let state: tauri::State<ServerState> = app.state();
    let guard = state.0.lock().unwrap();
    let Some(s) = guard.as_ref() else {
        drop(guard);
        let _ = app.notification().builder().title("服务未运行").show();
        return;
    };
    let port = s.port;
    drop(guard);
    // 取第一个私网地址 + 带配对码（手机粘贴即用）
    let public_url = read_config_str(&data_dir, "publicUrl")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    let token = read_token(&data_dir).unwrap_or_default();
    let base = if !public_url.is_empty() {
        public_url
    } else {
        match lanmd_server::lan::lan_addresses().first() {
            Some(ip) => format!("http://{ip}:{port}"),
            None => format!("http://localhost:{port}"),
        }
    };
    let target = if token.is_empty() {
        base
    } else {
        format!("{base}/?token={}", urlenc(&token))
    };
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(target.clone());
    }
    let _ = app.notification().builder().title("已复制").body(target).show();
}

fn read_token(data_dir: &PathBuf) -> Option<String> {
    read_config_str(data_dir, "token")
}

fn read_config_str(data_dir: &PathBuf, key: &str) -> Option<String> {
    let raw = std::fs::read_to_string(data_dir.join("config.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()?;
    v.get(key).and_then(|t| t.as_str()).map(|s| s.to_string())
}

fn urlenc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn open_subdir(app: &AppHandle, kind: &str) {
    let data_dir: PathBuf = app.state::<DataDir>().0.clone();
    let dir = match kind {
        "vault" => data_dir.join("vault"),
        "logs" => {
            let _ = std::fs::create_dir_all(data_dir.join("logs"));
            data_dir.join("logs")
        }
        _ => data_dir.to_path_buf(),
    };
    let _ = open::that(dir);
}
