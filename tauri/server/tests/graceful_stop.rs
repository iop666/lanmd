//! 优雅停服集成测试：`RunningServer::stop()` 必须立即使所有 SSE 流断开，
//! 并在有连接挂起的情况下于时限内返回（不得永久挂起）。
//!
//! 流程：进程内 start_server → 建立 2 条 SSE（各收到 ": hello"）→ stop()
//! → 断言两条流都 EOF（服务端主动关闭），且 stop() 总耗时 < 2 秒。

use std::time::{Duration, Instant};

use lanmd_server::{start_server, StartOpts};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test(flavor = "multi_thread")]
async fn stop_breaks_sse_and_returns_within_2s() {
    let data_dir = std::env::temp_dir().join(format!("lanmd-stop-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data_dir);
    std::fs::create_dir_all(&data_dir).unwrap();
    // 独立端口 + 预设配对码（/api/events 需要鉴权），避免与开发环境/其他测试冲突
    std::env::set_var("MDLIVE_PORT", "18797");
    std::env::set_var("MDLIVE_TOKEN", "tok");

    let server = start_server(StartOpts {
        data_dir: data_dir.clone(),
        web_dist: None,
    })
    .await
    .expect("start_server 失败");
    let port = server.port;

    let (mut r1, _w1) = open_sse(port).await;
    let (mut r2, _w2) = open_sse(port).await;

    let t0 = Instant::now();
    server.stop().await;
    let elapsed = t0.elapsed();

    for (name, r) in [("sse1", &mut r1), ("sse2", &mut r2)] {
        // 读到 EOF 为止（中间可能只有 HTTP chunked 终止符 0\r\n\r\n），
        // 断言：2 秒内 EOF 且 shutdown 后不再收到任何新事件。
        let mut extra: Vec<u8> = Vec::new();
        let closed = loop {
            let mut buf = [0u8; 256];
            match tokio::time::timeout(Duration::from_secs(2), r.read(&mut buf)).await {
                Ok(Ok(0)) => break true, // EOF：服务端关闭了连接 ✓
                Ok(Ok(n)) => extra.extend_from_slice(&buf[..n]),
                Ok(Err(_)) => break true, // 连接错误同样视为断开
                Err(_) => break false,    // 2 秒仍无 EOF
            }
        };
        assert!(closed, "{name}: stop() 后 2 秒内 SSE 流未断开（无 EOF）");
        assert!(
            !extra.windows(6).any(|w| w == b"event:"),
            "{name}: stop() 后仍收到新事件: {}",
            String::from_utf8_lossy(&extra)
        );
    }
    assert!(
        elapsed < Duration::from_secs(2),
        "stop() 耗时 {elapsed:?}，应 <2s（疑似挂起）"
    );

    let _ = std::fs::remove_dir_all(&data_dir);
}

/// 裸 TCP 打开 /api/events，等到 ": hello" 注释后返回读写两半。
/// 写半保留存活（不 drop），避免半关闭干扰 SSE 读取。
async fn open_sse(
    port: u16,
) -> (
    tokio::net::tcp::OwnedReadHalf,
    tokio::net::tcp::OwnedWriteHalf,
) {
    let s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect 失败");
    let (mut r, mut w) = s.into_split();
    w.write_all(
        b"GET /api/events?token=tok HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n",
    )
    .await
    .unwrap();
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), r.read(&mut chunk))
            .await
            .expect("等 : hello 超时")
            .expect("read 失败");
        assert!(n > 0, "连接在 : hello 之前被关闭");
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(7).any(|w| w == b": hello") {
            break;
        }
    }
    (r, w)
}
