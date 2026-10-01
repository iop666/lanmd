// 端到端同步测试：node --test scripts/test-sync.mjs
// 验证：SSE 连通 / 外部改盘 → 1.5s 内收到 file-changed / API 写盘 → 收到事件且内容一致
//       且 API 写盘只产生一次广播（回环抑制生效）/ 外部修改不被抑制 / 外部删除 → file-removed
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'testtoken2';
// 被测服务端：MDLIVE_SERVER_BIN 指向 Rust 版，否则 TS 版
const SERVER_BIN = process.env.MDLIVE_SERVER_BIN || path.join(ROOT, 'server', 'dist', 'index.js');
const IS_NODE = SERVER_BIN.endsWith('.js') || SERVER_BIN.endsWith('.mjs');
const WATCH = 'sync.md';

let server = null;
let base = '';
let vaultDir = '';

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

// ---------- 最小 SSE 客户端（支持多个并发 next()，孤儿等待者不会吞事件） ----------
function connectSse(url) {
  const queue = [];
  const waiters = []; // { resolve, reject, timer }
  let closed = false;

  function drain() {
    while (queue.length > 0 && waiters.length > 0) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.resolve(queue.shift());
    }
  }

  const push = (item) => {
    queue.push(item);
    drain();
  };

  const ready = fetch(url, { headers: {} }).then(async (res) => {
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('text/event-stream')) throw new Error(`bad content-type: ${ctype}`);
    const decoder = new TextDecoder();
    let buf = '';
    const reader = res.body.getReader();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let ev = 'message';
            let data = '';
            let comment = null;
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) {
                comment = line.slice(1).trim();
              } else if (line.startsWith('event:')) {
                ev = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                data += line.slice(5).trim();
              }
            }
            if (comment !== null && data === '') push({ comment });
            else if (data !== '') push({ event: ev, data: JSON.parse(data) });
          }
        }
      } catch {
        /* stream closed */
      } finally {
        closed = true;
        while (waiters.length > 0) {
          const w = waiters.shift();
          clearTimeout(w.timer);
          w.reject(new Error('SSE closed'));
        }
      }
    })();
    return res;
  });

  function next(timeoutMs = 3000) {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    if (closed) return Promise.reject(new Error('SSE closed'));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`等待 SSE 事件超时（${timeoutMs}ms）`));
      }, timeoutMs);
      waiters.push(w);
    });
  }

  return {
    ready,
    next,
    /** 收集直到 predicate 命中，返回期间收到的所有事件（含命中项） */
    async collectUntil(predicate, timeoutMs) {
      const seen = [];
      const t0 = Date.now();
      for (;;) {
        const left = timeoutMs - (Date.now() - t0);
        if (left <= 0) throw new Error(`collectUntil 超时，已收到 ${seen.length} 个事件`);
        try {
          const ev = await next(left);
          seen.push(ev);
          if (predicate(ev)) return seen;
        } catch (e) {
          throw new Error(`${e.message}；已收到: ${JSON.stringify(seen)}`);
        }
      }
    },
    close() {
      closed = true;
    },
  };
}

const isFileChanged = (ev, file) => ev.event === 'file-changed' && ev.data.path === file;

before(async () => {
  const fs = await import('node:fs/promises');
  try {
    await fs.access(SERVER_BIN);
  } catch {
    throw new Error(`未找到 ${SERVER_BIN}（先 npm run build 或 cargo build）`);
  }
  vaultDir = await mkdtemp(path.join(tmpdir(), 'mdlive-sync-'));
  await writeFile(path.join(vaultDir, WATCH), 'v0', 'utf8');

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = IS_NODE
    ? spawn(process.execPath, [SERVER_BIN], { cwd: ROOT, env: { ...process.env, MDLIVE_VAULT: vaultDir, MDLIVE_PORT: String(port), MDLIVE_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(SERVER_BIN, [], { cwd: ROOT, env: { ...process.env, MDLIVE_VAULT: vaultDir, MDLIVE_PORT: String(port), MDLIVE_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));
  await waitHealthy(base);
});

after(async () => {
  if (server) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await rm(vaultDir, { recursive: true, force: true }).catch(() => {});
});

test('SSE 连接建立即收到 hello 注释行', async () => {
  const sse = connectSse(`${base}/api/events?token=${TOKEN}`);
  try {
    await sse.ready;
    const first = await sse.next(3000);
    assert.equal(first.comment, 'hello');
  } finally {
    sse.close();
  }
});

test('SSE 无 token 被拒（401）', async () => {
  const res = await fetch(`${base}/api/events`);
  assert.equal(res.status, 401);
});

test('外部直接改盘 → 1.5 秒内收到 file-changed，version 与内容一致', async () => {
    const sse = connectSse(`${base}/api/events?token=${TOKEN}`);
    try {
      await sse.ready;
      const hello = await sse.next(3000);
      assert.equal(hello.comment, 'hello');
      const content = `external-${Date.now()}`;
    const t0 = Date.now();
    await writeFile(path.join(vaultDir, WATCH), content, 'utf8');
    const t0b = Date.now();
    const ev = await sse.next(1500 + (t0b - t0));
    assert.ok(isFileChanged(ev, WATCH), `应收到 file-changed，实际 ${JSON.stringify(ev)}`);
    assert.equal(ev.data.version, sha12(content));
    assert.ok(Date.now() - t0 < 1500, `事件延迟 ${Date.now() - t0}ms，超过 1.5s`);
  } finally {
    sse.close();
  }
});

test('API 写盘 → 收到事件且内容一致，且 3 秒内不出现重复广播（回环抑制）', async () => {
  const sse = connectSse(`${base}/api/events?token=${TOKEN}`);
  try {
    await sse.ready;
    // 排掉之前测试遗留的事件
    for (;;) {
      const peek = await Promise.race([
        sse.next(300).then(() => true),
        Promise.resolve(false),
      ]).catch(() => false);
      if (!peek) break;
    }
    const content = `via-api-${Date.now()}`;
    const t0 = Date.now();
    // 文件已存在（前面测试写入过），按契约带上当前版本
    const cur = await (await fetch(`${base}/api/file?path=${encodeURIComponent(WATCH)}`, { headers: H })).json();
    const putRes = await fetch(`${base}/api/file`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ path: WATCH, content, baseVersion: cur.version }),
    });
    assert.equal(putRes.status, 200);
    const events = await sse.collectUntil((ev) => isFileChanged(ev, WATCH) && ev.data.version === sha12(content), 1500);
    assert.ok(Date.now() - t0 < 1500, 'API 写入的主动广播应在 1.5s 内到达');
    const dup = events.filter((e) => isFileChanged(e, WATCH));
    assert.equal(dup.length, 1, `file-changed 应恰好一次（含 watcher 回声抑制验证），实际 ${JSON.stringify(events)}`);
    // 再静默观察一段时间，确认 watcher 没有把它当外部修改再广播一次（tree-changed 允许出现）
    const t1 = Date.now();
    try {
      for (;;) {
        const ev = await sse.next(Math.max(100, 1500 - (Date.now() - t1)));
        assert.ok(
          !isFileChanged(ev, WATCH),
          `不应有第二次 file-changed: ${JSON.stringify(ev)}`,
        );
      }
    } catch (e) {
      assert.match(e.message, /超时/, `观察期内不应有其它 file-changed，实际: ${e.message}`);
    }
    // 磁盘内容确认
    const fs = await import('node:fs/promises');
    assert.equal(await fs.readFile(path.join(vaultDir, WATCH), 'utf8'), content);
  } finally {
    sse.close();
  }
});

test('紧随 API 写盘之后的外部真实修改不被错误丢弃', async () => {
  const sse = connectSse(`${base}/api/events?token=${TOKEN}`);
  try {
    await sse.ready;
    for (;;) {
      const peek = await Promise.race([sse.next(300).then(() => true), Promise.resolve(false)]).catch(() => false);
      if (!peek) break;
    }
    const apiContent = `drain-${Date.now()}`;
    const cur = await (await fetch(`${base}/api/file?path=${encodeURIComponent(WATCH)}`, { headers: H })).json();
    await fetch(`${base}/api/file`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ path: WATCH, content: apiContent, baseVersion: cur.version }),
    });
    await sse.collectUntil((ev) => isFileChanged(ev, WATCH) && ev.data.version === sha12(apiContent), 1500);
    // 排掉残留的 tree-changed
    for (;;) {
      const more = await Promise.race([sse.next(200), Promise.resolve(null)]).catch(() => null);
      if (!more) break;
      if (isFileChanged(more, WATCH)) break;
    }
    // 立刻外部修改（仍在 3 秒抑制窗口内，但内容不同 → 必须广播）
    const ext = `real-external-${Date.now()}`;
    const t0 = Date.now();
    await writeFile(path.join(vaultDir, WATCH), ext, 'utf8');
    const ev = await sse.next(1500);
    assert.ok(isFileChanged(ev, WATCH), `应收到外部修改事件，实际 ${JSON.stringify(ev)}`);
    assert.equal(ev.data.version, sha12(ext));
    assert.ok(Date.now() - t0 < 1500);
  } finally {
    sse.close();
  }
});

test('外部删除 → 收到 file-removed', async () => {
  const sse = connectSse(`${base}/api/events?token=${TOKEN}`);
  try {
    await sse.ready;
    for (;;) {
      const peek = await Promise.race([sse.next(300).then(() => true), Promise.resolve(false)]).catch(() => false);
      if (!peek) break;
    }
    const gone = 'gone.md';
    await writeFile(path.join(vaultDir, gone), 'bye', 'utf8');
    // 等它的 add 事件先过去
    await sse.collectUntil((ev) => isFileChanged(ev, gone), 1500).catch(() => {});
    const fs = await import('node:fs/promises');
    await fs.rm(path.join(vaultDir, gone));
    const t0 = Date.now();
    // 中间可能夹着 tree-changed，用 collectUntil 精确等 file-removed
    const events = await sse.collectUntil((ev) => ev.event === 'file-removed' && ev.data.path === gone, 2000);
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(events.some((e) => e.event === 'file-removed'));
    await assert.rejects(() => access(path.join(vaultDir, gone)));
  } finally {
    sse.close();
  }
});
