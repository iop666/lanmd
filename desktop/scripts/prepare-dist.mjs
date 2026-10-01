// 打包准备：把编译好的 server/dist 拷到 desktop/server-dist，
// 与 desktop 的 node_modules（fastify 等）一起进 asar，保证运行时 import 解析成立
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const projectRoot = path.resolve(desktopRoot, '..');
const src = path.join(projectRoot, 'server', 'dist');
const dest = path.join(desktopRoot, 'server-dist');

if (!fs.existsSync(path.join(src, 'index.js'))) {
  throw new Error(`未找到 ${src}，请先运行 npm run build -w server`);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
// server 是 ESM：asr 根 package.json 是 CJS（main.js 需要），在 server-dist 里放独立标记
// 避免 Node 每次启动做模块类型探测（消除 MODULE_TYPELESS_PACKAGE_JSON 性能警告）
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
console.log(`copied server/dist -> desktop/server-dist (${fs.readdirSync(dest).length} entries)`);
