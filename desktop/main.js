'use strict';

/**
 * Lanmd Electron 外壳主进程：
 * - 不创建任何 BrowserWindow，托盘是唯一 UI
 * - 服务跑在主进程内（动态 import，见 server-host.js），无子进程
 * - 便携数据目录见 paths.js（PORTABLE_EXECUTABLE_DIR 陷阱在那里处理）
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, shell, Notification } = require('electron');
const paths = require('./paths');
const serverHost = require('./server-host');
const tray = require('./tray');

// ---- 数据目录重定向 + 单实例 ----
// userData（Chromium 缓存）重定向到 Lanmd-data/appdata，C 盘 %APPDATA% 不再出现 Lanmd 目录。
// C 盘唯一不可避免的是 portable 壳在 %TEMP% 的解压本体（electron-builder 固有，
// 正常退出自动清理，强杀残留可手动删）。
const resolvedData = paths.resolveDataDir(app);
try {
  app.setPath('userData', path.join(resolvedData.dataDir, 'appdata'));
} catch (e) {
  console.warn('[desktop] userData 重定向失败: ' + (e.message ?? e));
}

// ---- 自实现单实例 ----
// 不能用 app.requestSingleInstanceLock()：它的锁挂在 Chromium ProcessSingleton 上，
// 在 setPath('userData') 重定向后实测失效（双实例并存）。改为锁文件 + PID 存活检查：
// 第二实例读到活锁时，直接用系统浏览器打开已有实例的页面然后退出（效果等同 second-instance 聚焦）。
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSingleInstanceLock() {
  const lockPath = path.join(resolvedData.dataDir, 'lanmd.lock');
  try {
    if (fs.existsSync(lockPath)) {
      const old = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
      if (Number.isFinite(old) && old !== process.pid && pidAlive(old)) {
        return { ok: false };
      }
      // 残留锁（崩溃/强杀遗留）：unlink 后重新创建
      fs.rmSync(lockPath, { force: true });
    }
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    process.on('exit', () => {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* ignore */
      }
    });
    return { ok: true };
  } catch (e) {
    if (e.code === 'EEXIST') return { ok: false }; // 与另一实例同时启动，它赢了
    // 锁写不进去（只读数据目录等）：放行运行，可用性优先
    console.warn('[desktop] 单实例锁不可用: ' + (e.message ?? e));
    return { ok: true };
  }
}

const instanceLock = acquireSingleInstanceLock();
if (!instanceLock.ok) {
  // 已有实例在跑：打开它的页面后退出
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(resolvedData.dataDir, 'config.json'), 'utf8'));
    if (typeof cfg.port === 'number') {
      shell.openExternal(`http://localhost:${cfg.port}`);
    }
  } catch {
    /* 读不到配置就静默退出 */
  }
  app.quit();
} else {
  mainScope(resolvedData);
}

function mainScope(resolvedData) {
  /** @type {{dataDir: string, webDist: string, iconPath: string, warnIconPath: string, fallbackReason: string|null}} */
  const env = {};
  let server = null; // { port, stop, version, vault }
  let startError = null;
  let quitting = false;

  // ---- 日志：stdout/stderr 镜像到 dataDir/logs/server.log（>5MB 轮转） ----
  function setupLogging(logsDir) {
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'server.log');
    const rotate = () => {
      try {
        if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
          fs.rmSync(logFile + '.old', { force: true });
          fs.renameSync(logFile, logFile + '.old');
        }
      } catch {
        /* ignore */
      }
    };
    rotate();
    let stream = fs.createWriteStream(logFile, { flags: 'a' });
    stream.on('error', () => {}); // 流错误不允许冒泡成 uncaughtException
    let lines = 0;
    let bytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    // 会话内软上限：内存计数（不依赖落盘 flush），超 10MB 换新流。
    // 旧的流 end 后再 write 会抛 ERR_STREAM_WRITE_AFTER_END 且无人接住 → 主进程崩溃，
    // 必须 destroy + 等 close 重建。
    const reopen = () => {
      lines = 0;
      bytes = 0;
      const old = stream;
      old.destroy();
      old.on('close', () => {
        try {
          rotate();
        } catch {
          /* ignore */
        }
        stream = fs.createWriteStream(logFile, { flags: 'a' });
        stream.on('error', () => {});
        stream.write('--- log truncated (size limit) ---\n');
      });
    };
    const mirror = (orig) => (chunk, ...rest) => {
      try {
        const buf = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        stream.write(chunk);
        bytes += buf;
        if (++lines % 4000 === 0 && bytes > 10 * 1024 * 1024) {
          reopen();
        }
      } catch {
        /* ignore */
      }
      return orig(chunk, ...rest);
    };
    process.stdout.write = mirror(process.stdout.write.bind(process.stdout));
    process.stderr.write = mirror(process.stderr.write.bind(process.stderr));
  }

  function notify(title, body) {
    try {
      if (Notification.isSupported()) {
        new Notification({ title, body: body ?? '', silent: false }).show();
      }
    } catch {
      /* 通知被系统关闭等情况：不影响功能 */
    }
  }

  function lanUrls(port) {
    // 复用 server 的 lan.js：直接 require（同仓库，CJS 侧无法 import ESM，简单重复实现）
    const os = require('node:os');
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        if (/^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ni.address)) out.push(ni.address);
      }
    }
    out.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
    return out.map((ip) => `http://${ip}:${port}`);
  }

  function shareUrl(url) {
    // 带上配对码，手机粘贴即用
    try {
      const cfgPath = path.join(env.dataDir, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (typeof cfg.token === 'string' && cfg.token !== '') {
        return `${url}/?token=${encodeURIComponent(cfg.token)}`;
      }
    } catch {
      /* ignore */
    }
    return url;
  }

  function openApp() {
    if (server) {
      shell.openExternal(`http://localhost:${server.port}`);
    } else if (startError) {
      notify('Lanmd 未运行', startError);
    } else {
      notify('Lanmd 正在启动…', '请稍候片刻再点击');
    }
  }

  function openFolder(kind) {
    const map = {
      vault: path.join(env.dataDir, 'vault'),
      data: env.dataDir,
      logs: path.join(env.dataDir, 'logs'),
    };
    const dir = map[kind] ?? env.dataDir;
    if (kind === 'logs') fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir).then((errText) => {
      if (errText) notify('无法打开文件夹', errText);
    });
  }

  async function startService() {
    startError = null;
    tray.setStatus('starting');
    try {
      server = await serverHost.start(app, { dataDir: env.dataDir, webDist: env.webDist });
      tray.setStatus('running', { port: server.port, urls: lanUrls(server.port) });
      notify('Lanmd 已启动', '点击托盘图标打开');
    } catch (e) {
      server = null;
      console.error('[desktop] 服务启动失败:', e && e.stack ? e.stack : String(e));
      startError = e.port ? `端口 ${e.port} 被占用` : String(e.message ?? e);
      tray.setStatus('error', { errorText: startError });
      notify('Lanmd 启动失败', startError + '（右键托盘可重试）');
    }
  }

  async function restartService() {
    // stop 超时（!ok）说明旧服务还活着：如实报告，不继续启动（否则必然端口占用假错误）
    tray.setStatus('starting');
    const ok = await serverHost.stop(3000);
    server = null;
    if (!ok) {
      startError = '旧服务未能在超时内停止，可能仍在运行';
      console.error('[desktop] ' + startError);
      tray.setStatus('error', { errorText: startError });
      notify('重启中止', startError + '，当前服务可能仍可用');
      return;
    }
    await startService();
    if (server) notify('服务已重启', '若浏览器页面已打开，请刷新');
  }

  async function quit() {
    if (quitting) return;
    quitting = true;
    try {
      await serverHost.stop(3000);
    } catch {
      /* ignore */
    }
    tray.destroy();
    app.quit();
  }

  app.on('before-quit', (e) => {
    if (!quitting) {
      e.preventDefault();
      void quit();
    }
  });

  app.on('window-all-closed', () => {
    /* 没有窗口；保持托盘运行 */
  });

  app.whenReady().then(async () => {
    env.dataDir = resolvedData.dataDir;
    env.webDist = paths.resolveWebDist(app);
    env.iconPath = path.join(paths.resolveIconDir(app), 'icon.ico');
    env.warnIconPath = path.join(paths.resolveIconDir(app), 'icon-warn.ico');
    setupLogging(path.join(env.dataDir, 'logs'));
    fs.mkdirSync(path.join(env.dataDir, 'vault'), { recursive: true });

    // Chromium 引擎在 JS main 运行前就已初始化，可能在旧默认位置留一个 0 文件空目录；
    // userData 已重定向到 Lanmd-data/appdata，这里把空壳顺手清掉（非空则保留不动）
    try {
      const legacy = path.join(app.getPath('appData'), 'lanmd-desktop');
      if (fs.existsSync(legacy) && fs.readdirSync(legacy).length === 0) {
        fs.rmdirSync(legacy);
      }
    } catch {
      /* ignore */
    }

    if (resolvedData.fallback) {
      console.warn('[desktop] 数据目录回退: ' + resolvedData.reason);
      notify(
        '数据目录已回退',
        resolvedData.reason + '。注意：此前若在其它目录运行过，笔记数据仍在当时的数据文件夹中，不会自动迁移。',
      );
    }

    tray.create({
      iconPath: env.iconPath,
      iconDir: paths.resolveIconDir(app),
      initialStatus: 'starting',
      hooks: {
        openApp,
        openFolder,
        notify,
        restartService,
        quit,
        shareUrl,
        setAutoLaunch: (on, exe) => {
          try {
            app.setLoginItemSettings({ openAtLogin: on, path: exe });
          } catch (err) {
            notify('设置开机自启失败', String(err.message ?? err));
          }
        },
      },
    });

    await startService();
  });
}
