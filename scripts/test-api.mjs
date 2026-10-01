// API 自动化测试：node --test scripts/test-api.mjs
// 覆盖：health / 鉴权 / tree / 读 / 写 / 版本冲突 409 / 路径穿越 / 符号链接逃逸 / 删除 / 重命名 / mkdir / 并发写
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'testtoken1';
// 被测服务端：MDLIVE_SERVER_BIN 指向 Rust 版（lanmd-server.exe），否则用 TS 版（node server/dist/index.js）
const SERVER_BIN = process.env.MDLIVE_SERVER_BIN || path.join(ROOT, 'server', 'dist', 'index.js');
const IS_NODE = SERVER_BIN.endsWith('.js') || SERVER_BIN.endsWith('.mjs');

let server = null; // 实例 A：MDLIVE_TOKEN 预置（测试常规接口）
let serverB = null; // 实例 B：无 token（测试首次设置配对码流程）
let base = '';
let baseB = '';
let vaultDir = '';
let vaultDirB = '';
let outsideDir = '';

const HB = () => ({ Authorization: 'Bearer pair123', 'Content-Type': 'application/json' });

function spawnServer(vault, port, tokenEnv) {
  const env = { ...process.env, MDLIVE_VAULT: vault, MDLIVE_PORT: String(port) };
  if (tokenEnv) env.MDLIVE_TOKEN = tokenEnv;
  const s = IS_NODE
    ? spawn(process.execPath, [SERVER_BIN], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(SERVER_BIN, [], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  s.stdout.on('data', () => {});
  s.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));
  return s;
}

function sha12(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function waitHealthy(url, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        const j = await res.json();
        if (j && j.ok === true) return;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('server did not become healthy in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
// DELETE 不带 body：不能附带 Content-Type，否则 fastify 会因空 JSON body 报 400
const HDEL = { Authorization: `Bearer ${TOKEN}` };

function get(file, headers = H) {
  return fetch(`${base}/api/file?path=${encodeURIComponent(file)}`, { headers });
}
function put(body, headers = H) {
  return fetch(`${base}/api/file`, { method: 'PUT', headers, body: JSON.stringify(body) });
}
function del(file, headers = HDEL) {
  return fetch(`${base}/api/file?path=${encodeURIComponent(file)}`, { method: 'DELETE', headers });
}

before(async () => {
  const fs = await import('node:fs/promises');
  try {
    await fs.access(SERVER_BIN);
  } catch {
    throw new Error(`未找到 ${SERVER_BIN}（先 npm run build 或 cargo build）`);
  }

  vaultDir = await mkdtemp(path.join(tmpdir(), 'mdlive-api-'));
  vaultDirB = await mkdtemp(path.join(tmpdir(), 'mdlive-pair-'));
  outsideDir = await mkdtemp(path.join(tmpdir(), 'mdlive-out-'));
  await mkdir(path.join(vaultDir, 'sub', 'deep'), { recursive: true });
  await writeFile(path.join(vaultDir, 'a.md'), '# A\nhello');
  await writeFile(path.join(vaultDir, '中文.md'), '# 中文内容 🙂');
  await writeFile(path.join(vaultDir, 'sub', 'b.md'), 'B');
  await writeFile(path.join(vaultDir, '.hidden.md'), 'hidden');
  await mkdir(path.join(vaultDir, 'node_modules'), { recursive: true });
  await writeFile(path.join(vaultDir, 'node_modules', 'n.md'), 'n');
  await writeFile(path.join(outsideDir, 'secret.txt'), 'TOP SECRET');

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawnServer(vaultDir, port, TOKEN);
  await waitHealthy(base);

  const portB = await freePort();
  baseB = `http://127.0.0.1:${portB}`;
  serverB = spawnServer(vaultDirB, portB, null);
  await waitHealthy(baseB);
});

after(async () => {
  for (const s of [server, serverB]) {
    if (s) {
      const exited = new Promise((r) => s.once('exit', r));
      s.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (s.exitCode === null) s.kill('SIGKILL');
    }
  }
  await rm(vaultDir, { recursive: true, force: true }).catch(() => {});
  await rm(vaultDirB, { recursive: true, force: true }).catch(() => {});
  await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
});

test('health 无需 token', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.vault, 'string');
  assert.equal(typeof j.version, 'string');
  assert.equal(j.paired, true, 'MDLIVE_TOKEN 注入时 paired 应为 true');
});

test('受保护接口无 token 返回 401', async () => {
  for (const [method, url] of [
    ['GET', `${base}/api/tree`],
    ['GET', `${base}/api/file?path=a.md`],
    ['PUT', `${base}/api/file`],
    ['DELETE', `${base}/api/file?path=a.md`],
  ]) {
    const res = await fetch(url, { method });
    assert.equal(res.status, 401, `${method} ${url}`);
  }
});

test('错误 token 返回 401', async () => {
  const res = await fetch(`${base}/api/tree`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(res.status, 401);
});

test('pair：正确 code 换取 token，错误 code 401', async () => {
  const ok = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: TOKEN }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).token, TOKEN);
  const bad = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'nope' }),
  });
  assert.equal(bad.status, 401);
});

test('tree：只含 .md，忽略隐藏与 ignore 目录，文件排在目录前', async () => {
  const res = await fetch(`${base}/api/tree`, { headers: H });
  assert.equal(res.status, 200);
  const { items } = await res.json();
  const names = items.map((n) => n.name);
  assert.ok(names.includes('a.md'));
  assert.ok(names.includes('中文.md'));
  assert.ok(!names.some((n) => n.startsWith('.')));
  assert.ok(!names.includes('node_modules'));
  const firstDir = items.findIndex((n) => n.type === 'dir');
  const lastFile = items.map((n) => n.type).lastIndexOf('file');
  if (firstDir >= 0 && lastFile >= 0) assert.ok(lastFile < firstDir, '文件应排在目录前面');
  const sub = items.find((n) => n.path === 'sub');
  assert.ok(sub && sub.type === 'dir');
  assert.ok(sub.children.some((c) => c.path === 'sub/b.md'));
});

test('读文件返回 content/version/mtime，version 为 sha1 前 12 位', async () => {
  const res = await get('a.md');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.content, '# A\nhello');
  assert.equal(j.version, sha12('# A\nhello'));
  assert.equal(typeof j.mtime, 'number');
});

test('读不存在的文件 404，读目录 404', async () => {
  assert.equal((await get('nope.md')).status, 404);
  assert.equal((await get('sub')).status, 404);
});

test('路径穿越全部被拒（../、URL 编码、反斜杠、绝对路径、盘符、NUL）', async () => {
  const bad = [
    '../../../windows/win.ini',
    '..%2F..%2Fwindows%2Fwin.ini', // 手工二次编码进 query
    'a/../../x.md',
    '..',
    '../',
    'C:/windows/win.ini',
    'C:\\windows\\win.ini',
    '..\\..\\windows\\win.ini',
    'a\\..\\..\\x.md',
    '/etc/passwd',
    '\\windows\\win.ini',
    'a.md\0.png',
  ];
  for (const p of bad) {
    const res = await fetch(`${base}/api/file?path=${p}`, { headers: H });
    assert.ok([400, 404].includes(res.status), `GET path=${p} -> ${res.status}`);
    if (p === '../../../windows/win.ini' || p === '..%2F..%2Fwindows%2Fwin.ini') {
      assert.equal(res.status, 400, `必须 400: ${p}`);
    }
  }
  // PUT / DELETE / rename / mkdir 同样拒绝
  assert.equal((await put({ path: '../evil.md', content: 'x', baseVersion: null })).status, 400);
  assert.equal((await put({ path: 'a\\..\\..\\evil.md', content: 'x', baseVersion: null })).status, 400);
  assert.equal((await del('../a.md')).status, 400);
  const ren = await fetch(`${base}/api/file/rename`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ from: 'a.md', to: '../evil.md' }),
  });
  assert.equal(ren.status, 400);
  const mk = await fetch(`${base}/api/file/mkdir`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ path: '../evil' }),
  });
  assert.equal(mk.status, 400);
  // 确认没有写出去
  const fs = await import('node:fs/promises');
  await assert.rejects(() => fs.access(path.join(vaultDir, '..', 'evil.md')));
});

test('符号链接逃逸被拒（无权限的环境自动跳过）', async (t) => {
  try {
    await symlink(path.join(outsideDir, 'secret.txt'), path.join(vaultDir, 'le.md'));
    await symlink(outsideDir, path.join(vaultDir, 'ledir'));
  } catch {
    t.skip('当前环境无符号链接权限（Windows 未开启开发者模式）');
    return;
  }
  const viaFile = await get('le.md');
  assert.equal(viaFile.status, 400, '符号链接文件指向 vault 外必须 400');
  const viaDir = await get('ledir/secret.txt');
  assert.equal(viaDir.status, 400, '经由符号链接目录读取必须 400');
});

test('NTFS junction 指向 vault 外被拒（免管理员权限，Windows 可测）', async (t) => {
  try {
    await symlink(outsideDir, path.join(vaultDir, 'jdir'), 'junction');
  } catch {
    t.skip('当前环境无法创建 NTFS junction');
    return;
  }
  const viaDir = await get('jdir/secret.txt');
  assert.equal(viaDir.status, 400, '经由 junction 目录读取必须 400');
  const viaPut = await put({ path: 'jdir/evil.md', content: 'x', baseVersion: null });
  assert.equal(viaPut.status, 400, '经由 junction 目录写入必须 400');
  const { items } = await (await fetch(`${base}/api/tree`, { headers: H })).json();
  assert.ok(!JSON.stringify(items).includes('jdir'), '文件树不应列出 junction 目录');
  const fs = await import('node:fs/promises');
  await assert.rejects(() => fs.access(path.join(outsideDir, 'evil.md')), 'vault 外不应出现新文件');
});

test('PUT 新建（baseVersion=null）→ 落盘并返回 version', async () => {
  const res = await put({ path: 'new.md', content: 'hi 新建', baseVersion: null });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.version, sha12('hi 新建'));
  assert.equal(typeof j.mtime, 'number');
  const fs = await import('node:fs/promises');
  assert.equal(await fs.readFile(path.join(vaultDir, 'new.md'), 'utf8'), 'hi 新建');
});

test('PUT 新建但文件已存在 → 409 + currentVersion + content', async () => {
  const res = await put({ path: 'new.md', content: 'again', baseVersion: null });
  assert.equal(res.status, 409);
  const j = await res.json();
  assert.equal(j.error, 'conflict');
  assert.equal(j.currentVersion, sha12('hi 新建'));
  assert.equal(j.content, 'hi 新建');
});

test('PUT baseVersion 不匹配 → 409；匹配 → 成功', async () => {
  const wrong = await put({ path: 'new.md', content: 'x', baseVersion: '000000000000' });
  assert.equal(wrong.status, 409);
  const right = await put({ path: 'new.md', content: 'v2 内容', baseVersion: sha12('hi 新建') });
  assert.equal(right.status, 200);
  const j = await right.json();
  assert.equal(j.version, sha12('v2 内容'));
});

test('PUT 更新已被外部删除的文件（baseVersion 非空）→ 409', async () => {
  const fs = await import('node:fs/promises');
  await fs.rm(path.join(vaultDir, 'new.md'));
  const res = await put({ path: 'new.md', content: 'x', baseVersion: sha12('v2 内容') });
  assert.equal(res.status, 409);
  const j = await res.json();
  assert.equal(j.currentVersion, null);
  // 重新以 null 新建，供后续测试使用
  assert.equal((await put({ path: 'new.md', content: 'recreated', baseVersion: null })).status, 200);
});

test('PUT 自动创建父目录', async () => {
  const res = await put({ path: 'x/y/z.md', content: 'deep', baseVersion: null });
  assert.equal(res.status, 200);
  const fs = await import('node:fs/promises');
  assert.equal(await fs.readFile(path.join(vaultDir, 'x', 'y', 'z.md'), 'utf8'), 'deep');
});

test('同一 baseVersion 的两个并发 PUT：恰好一个 200 一个 409', async () => {
  await put({ path: 'conc.md', content: 'v0', baseVersion: null });
  const v0 = sha12('v0');
  const [r1, r2] = await Promise.all([
    put({ path: 'conc.md', content: 'vA', baseVersion: v0 }),
    put({ path: 'conc.md', content: 'vB', baseVersion: v0 }),
  ]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [200, 409]);
});

test('中文文件名 + emoji 内容读写正常', async () => {
  const content = '# 标题\n\n中文内容，含 emoji 🙂🐍 与 "引号"。\n';
  const created = await put({ path: '目录/中文笔记.md', content, baseVersion: null });
  assert.equal(created.status, 200);
  const back = await get('目录/中文笔记.md');
  assert.equal(back.status, 200);
  const j = await back.json();
  assert.equal(j.content, content);
  assert.equal(j.version, sha12(content));
});

test('DELETE：删除后 404；再删 404', async () => {
  const ok = await del('new.md');
  assert.equal(ok.status, 200);
  assert.equal((await get('new.md')).status, 404);
  assert.equal((await del('new.md')).status, 404);
  assert.equal((await del('sub')).status, 400); // 目录不允许删除
});

test('rename：旧路径消失新路径可读；目标已存在 409', async () => {
  const fs = await import('node:fs/promises');
  await put({ path: 'ren-src.md', content: 'rename me', baseVersion: null });
  const res = await fetch(`${base}/api/file/rename`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ from: 'ren-src.md', to: 'ren-dst.md' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await get('ren-src.md')).status, 404);
  const dst = await get('ren-dst.md');
  assert.equal(dst.status, 200);
  assert.equal((await dst.json()).content, 'rename me');
  const dup = await fetch(`${base}/api/file/rename`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ from: 'ren-dst.md', to: 'a.md' }),
  });
  assert.equal(dup.status, 409);
  await fs.access(path.join(vaultDir, 'a.md')); // 原文件没被动过
});

test('mkdir：递归创建且幂等；撞已存在文件返回 409', async () => {
  const mk = (p) =>
    fetch(`${base}/api/file/mkdir`, { method: 'POST', headers: H, body: JSON.stringify({ path: p }) });
  assert.equal((await mk('made/dir')).status, 200);
  assert.equal((await mk('made/dir')).status, 200);
  assert.equal((await mk('made')).status, 200); // 已存在目录幂等
  assert.equal((await mk('a.md')).status, 409); // 同名文件存在
  const tree = await (await fetch(`${base}/api/tree`, { headers: H })).json();
  const made = tree.items.find((n) => n.path === 'made');
  assert.ok(made && made.type === 'dir');
});

test('pair 限速：连续错误尝试最终触发 429', async () => {
  let saw429 = false;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: `wrong-${i}` }),
    });
    if (res.status === 429) {
      saw429 = true;
      break;
    }
    assert.ok([401].includes(res.status), `中间状态应 401，实际 ${res.status}`);
  }
  assert.ok(saw429, '应在多次失败尝试后触发 429');
});

test('非法请求体返回 400 而不是 500', async () => {
  assert.equal((await put({ path: 123, content: 'x', baseVersion: null })).status, 400);
  assert.equal((await put({ path: 'ok.md', content: 42, baseVersion: null })).status, 400);
  assert.equal((await put({ path: 'ok.md', content: 'x', baseVersion: 5 })).status, 400);
});

// ===== 实例 B：首次设置配对码流程（未预置 token） =====

test('pair 实例：health 返回 paired=false', async () => {
  const res = await fetch(`${baseB}/api/health`);
  assert.equal((await res.json()).paired, false);
});

test('pair 实例：未设置时所有受保护接口 401', async () => {
  const res = await fetch(`${baseB}/api/tree`);
  assert.equal(res.status, 401);
});

test('pair 实例：setup-pin 设置配对码并立即生效', async () => {
  const bad = await fetch(`${baseB}/api/setup-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '' }),
  });
  assert.equal(bad.status, 400, '空配对码应 400');
  const res = await fetch(`${baseB}/api/setup-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'pair123' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).token, 'pair123');
  const tree = await fetch(`${baseB}/api/tree`, { headers: { Authorization: 'Bearer pair123' } });
  assert.equal(tree.status, 200, '设置后配对码应立即生效');
  const health = await (await fetch(`${baseB}/api/health`)).json();
  assert.equal(health.paired, true);
});

test('pair 实例：设置后再次 setup-pin 应 403', async () => {
  const res = await fetch(`${baseB}/api/setup-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'another' }),
  });
  assert.equal(res.status, 403);
});

test('pair 实例：pair 校验配对码（错误 401 / 正确 200）', async () => {
  const bad = await fetch(`${baseB}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${baseB}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'pair123' }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).token, 'pair123');
});

test('pair 实例：connect-info 返回局域网地址与含配对码的二维码', async () => {
  const res = await fetch(`${baseB}/api/connect-info`, { headers: { Authorization: 'Bearer pair123' } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(Array.isArray(j.urls) && j.urls.length > 0, '应至少解析出一个局域网地址');
  assert.ok(j.urls[0].startsWith('http://'));
  assert.ok(typeof j.qr === 'string' && j.qr.startsWith('data:image/'), 'qr 应为 dataURL');
  assert.ok(j.qr.length > 100, '二维码 dataURL 不应为空壳');
});

test('connect-info 无 token 401；token 校验通过返回 urls+qr', async () => {
  const noAuth = await fetch(`${base}/api/connect-info`);
  assert.equal(noAuth.status, 401);
  const res = await fetch(`${base}/api/connect-info`, { headers: H });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(Array.isArray(j.urls));
  assert.ok(typeof j.qr === 'string' && j.qr.startsWith('data:image/'));
});

// ===== 倒计时暂存库 =====

test('timed：初始 6 个空槽（1小时×2 / 30分钟×2 / 10分钟×2）', async () => {
  const res = await fetch(`${base}/api/timed`, { headers: H });
  assert.equal(res.status, 200);
  const { items } = await res.json();
  assert.equal(items.length, 6);
  const durations = items.map((i) => i.durationMs).sort((a, b) => a - b);
  assert.deepEqual(durations, [600000, 600000, 1800000, 1800000, 3600000, 3600000]);
  for (const it of items) {
    assert.equal(it.exists, false);
    assert.equal(it.remainingMs, null);
    assert.ok(it.path.startsWith('.timed/'));
  }
});

test('timed：写入槽后倒计时启动且不超过时长', async () => {
  const created = await put({ path: '.timed/10m-1.md', content: '临时内容', baseVersion: null });
  assert.equal(created.status, 200);
  const { items } = await (await fetch(`${base}/api/timed`, { headers: H })).json();
  const slot = items.find((i) => i.id === '10m-1');
  assert.equal(slot.exists, true);
  assert.ok(slot.remainingMs > 0 && slot.remainingMs <= 600000, `remaining=${slot.remainingMs}`);
  const st = await import('node:fs/promises').then((fs) => fs.stat(path.join(vaultDir, '.timed', '10m-1.md')));
  assert.ok(st.isFile());
});

test('timed：槽文件不出现在文件树（. 开头被忽略）', async () => {
  const { items } = await (await fetch(`${base}/api/tree`, { headers: H })).json();
  assert.ok(!JSON.stringify(items).includes('.timed'), '文件树不应包含 .timed');
});

test('timed：过期槽被自动删除', async () => {
  const fs = await import('node:fs/promises');
  // 把 mtime 拨到 11 分钟前（10 分钟槽已过期）
  const past = new Date(Date.now() - 11 * 60_000);
  await fs.utimes(path.join(vaultDir, '.timed', '10m-1.md'), past, past);
  const { items } = await (await fetch(`${base}/api/timed`, { headers: H })).json();
  const slot = items.find((i) => i.id === '10m-1');
  assert.equal(slot.exists, false);
  assert.equal(slot.remainingMs, null);
  await assert.rejects(() => fs.access(path.join(vaultDir, '.timed', '10m-1.md')), '磁盘文件应被删除');
});

test('timed：time 编辑其他槽不受影响', async () => {
  const { items } = await (await fetch(`${base}/api/timed`, { headers: H })).json();
  for (const it of items) {
    if (it.id !== '10m-1') assert.equal(it.exists, false, `${it.id} 不应受影响`);
  }
});
