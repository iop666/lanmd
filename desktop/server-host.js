'use strict';

/**
 * 内嵌服务宿主：服务跑在 Electron 主进程内（动态 import 编译后的 server），
 * 绝不 spawn 子进程 —— 否则退出时容易留下孤儿 node 进程。
 * ESM 的动态 import 有模块缓存，但 startServer() 每次调用都会创建全新的
 * Fastify/Vault/Watcher 实例，因此重启是安全的。
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let current = null; // { server: { port, stop }, startedAt }
let starting = null; // in-flight 启动去重：并发 start() 共享同一次启动（防止快速双击重启出现双启动竞态）

function serverEntry(app) {
  if (app.isPackaged) {
    // asar 内：app.asar/{main.js, server-dist/index.js, node_modules/...}
    return path.join(__dirname, 'server-dist', 'index.js');
  }
  return path.join(__dirname, '..', 'server', 'dist', 'index.js');
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(app, { dataDir, webDist }) {
  if (current) return current.server;
  if (starting) return starting;
  starting = (async () => {
    try {
      // 桌面版语境下清掉可能劫持配置的环境变量（用户 shell 里恰好设了 MDLIVE_* 时，
      // 打包版会静默忽略自身 config.json，行为出乎意料）
      for (const k of ['MDLIVE_VAULT', 'MDLIVE_PORT', 'MDLIVE_TOKEN']) delete process.env[k];
      process.env.MDLIVE_DATA_DIR = dataDir;
      if (webDist) process.env.MDLIVE_WEB_DIST = webDist;
      const entry = serverEntry(app);
      // Windows 盘符路径不是合法的 ESM URL，必须转 file:// 才能动态 import
      const mod = await import(pathToFileURL(entry).href);
      const server = await mod.startServer({ webDist });
      current = { server, startedAt: Date.now() };
      return server;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** 停服：带超时兜底。返回是否在超时内完成；超时时旧服务可能仍在监听，调用方应中止后续启动 */
async function stop(timeoutMs = 3000) {
  if (!current) return true;
  const s = current.server;
  current = null;
  const ok = await Promise.race([
    s.stop().then(
      () => true,
      () => false,
    ),
    delay(timeoutMs).then(() => false),
  ]);
  return ok;
}

let restarting = false;

/** 重启：串行化（in-flight 时直接等待完成，不会并发出第二个 start） */
async function restart(app, opts) {
  if (restarting) {
    while (restarting) await delay(100);
    return current ? current.server : null;
  }
  restarting = true;
  try {
    await stop();
    return await start(app, opts);
  } finally {
    restarting = false;
  }
}

function isRunning() {
  return current !== null;
}

function getPort() {
  return current ? current.server.port : null;
}

function getServerInfo() {
  return current ? current.server : null;
}

module.exports = { start, stop, restart, isRunning, getPort, getServerInfo };
