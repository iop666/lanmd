use sha2::{Digest, Sha256};

/// 内容 sha1 前 12 位（version）
pub fn sha12(content: &str) -> String {
    use sha1::{Digest as _, Sha1};
    let mut h = Sha1::new();
    h.update(content.as_bytes());
    let d = h.finalize();
    hex(&d)[..12].to_string()
}

pub fn sha256_bytes(s: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().into()
}

/// 常数时间比较（等长字节逐位 OR）
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
