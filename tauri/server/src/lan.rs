/// 只保留 IPv4、非回环、私网网段；192.168.* 优先
pub fn lan_addresses() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&("localhost", 0)) {
        void(addrs);
    }
    // to_socket_addrs 不给网卡列表；用 ipconfig 输出解析或 windows API——
    // 简单可靠方案：解析 `ipconfig` 文本（Windows 自带，无需额外依赖）
    if let Ok(out_text) = std::process::Command::new("ipconfig").output() {
        let text = String::from_utf8_lossy(&out_text.stdout);
        for line in text.lines() {
            let l = line.trim();
            // 兼容中英文系统："IPv4 Address" / "IPv4 地址"
            if (l.contains("IPv4") || l.contains("ipv4")) && l.contains(':') {
                if let Some(ip) = l.rsplit(':').next() {
                    let ip = ip.trim().replace('(', "").replace(')', "");
                    if is_private_ipv4(&ip) {
                        out.push(ip);
                    }
                }
            }
        }
    }
    out.sort_by_key(|ip| std::cmp::Reverse(ip.starts_with("192.168.")));
    out.dedup();
    out
}

fn void<T>(_: T) {}

fn is_private_ipv4(ip: &str) -> bool {
    let parts: Vec<u32> = ip
        .split('.')
        .filter_map(|p| p.parse::<u32>().ok())
        .collect();
    if parts.len() != 4 || parts.iter().any(|p| *p > 255) {
        return false;
    }
    let [a, b, _, _] = [parts[0], parts[1], parts[2], parts[3]];
    a == 192 && b == 168 || a == 10 || a == 172 && (16..=31).contains(&b)
}
