// 供 start.bat 读取「将要用到的端口」，与 server 端 config.ts 的优先级保持一致：
// 环境变量 MDLIVE_PORT > config.json 的 port > 默认 8787
import fs from 'node:fs';

let port = 8787;
try {
  const raw = fs
    .readFileSync(new URL('../config.json', import.meta.url), 'utf8')
    .replace(/^\uFEFF/, ''); // 容忍记事本保存出的 UTF-8 BOM
  const j = JSON.parse(raw);
  if (typeof j.port === 'number' && Number.isFinite(j.port)) port = j.port;
} catch {
  /* 没有 config.json 或解析失败时用默认值，与 server 行为一致 */
}
if (process.env.MDLIVE_PORT) {
  const p = Number.parseInt(process.env.MDLIVE_PORT, 10);
  if (Number.isFinite(p) && p > 0) port = p;
}
console.log(port);
