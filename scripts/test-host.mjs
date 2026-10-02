// startServer 导出路径的测试（图形外壳使用同一入口）：
// 起服 → health 可用 → stop → 端口释放 → 重启 → 再停。验证可重入与干净关闭。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import { fileURLToPath, pathToFileURL } from 'node:url';

let vaultDir = '';
let serverMod = null;

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

before(async () => {
  vaultDir = await mkdtemp(path.join(tmpdir(), 'mdlive-host-'));
  process.env.MDLIVE_VAULT = vaultDir;
  serverMod = await import(pathToFileURL(path.join(ROOT, 'server', 'dist', 'index.js')).href);
});

after(async () => {
  await rm(vaultDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.MDLIVE_VAULT;
});

test('startServer：启动、health 可用、stop 干净、可再次启动（可重入）', async () => {
  const port = await freePort();
  process.env.MDLIVE_PORT = String(port);

  const s1 = await serverMod.startServer();
  assert.equal(s1.port, port);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);

  await s1.stop();
  let freed = false;
  const probe = net.createServer();
  probe.once('error', () => {});
  await new Promise((r) => {
    probe.listen(port, '127.0.0.1', () => {
      freed = true;
      probe.close(() => r());
    });
    setTimeout(() => r(), 3000);
  });
  assert.ok(freed, 'stop() 后端口应立即释放');
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${port}/api/health`),
    'stop() 后接口应不可达',
  );

  // 可重入：同一模块再次 startServer 成功
  const s2 = await serverMod.startServer();
  const health2 = await fetch(`http://127.0.0.1:${s2.port}/api/health`);
  assert.equal(health2.status, 200);
  await s2.stop();
});

test('startServer：端口被占用时抛 PortInUseError', async () => {
  const port = await freePort();
  process.env.MDLIVE_PORT = String(port);
  const s = await serverMod.startServer();
  try {
    await assert.rejects(
      () => serverMod.startServer(),
      (e) => e.name === 'PortInUseError' && e.port === port,
      '第二个实例应抛 PortInUseError',
    );
  } finally {
    await s.stop();
  }
});
