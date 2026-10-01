//! CLI 入口：node dist/index.js 的等价物（供自动化测试与无托盘场景使用）。
//! 环境变量：MDLIVE_DATA_DIR / MDLIVE_VAULT / MDLIVE_PORT / MDLIVE_TOKEN / MDLIVE_WEB_DIST

use std::path::PathBuf;

#[tokio::main]
async fn main() {
    env_logger::init();
    let data_dir = std::env::var("MDLIVE_DATA_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."))
                .join("Lanmd-data")
        });
    let web_dist = std::env::var("MDLIVE_WEB_DIST")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let server = match lanmd_server::start_server(lanmd_server::StartOpts { data_dir, web_dist }).await {
        Ok(s) => s,
        Err(lanmd_server::ApiError::PortInUse(p)) => {
            eprintln!("[error] 启动失败: 端口 {p} 已被占用（请换端口或停止占用该端口的程序）");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("[error] 启动失败: {e:?}");
            std::process::exit(1);
        }
    };

    wait_for_ctrl_c().await;
    eprintln!("[info] 正在关闭…");
    server.stop().await;
}

async fn wait_for_ctrl_c() {
    #[cfg(windows)]
    {
        // Windows 上 tokio::signal::ctrl_c 可用；同时监听 TASKKILL 触发的关闭不可行，
        // 测试用 stop() 主动停服，这里只等 Ctrl+C
        let _ = tokio::signal::ctrl_c().await;
    }
    #[cfg(not(windows))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
