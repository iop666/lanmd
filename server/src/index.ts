import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { loadConfig, projectRoot } from './config.js';
import { log } from './log.js';
import { lanAddresses } from './lan.js';
import { Vault, HttpError } from './vault.js';
import { startWatcher } from './watcher.js';
import { EventBus } from './events.js';
import { TimedVault } from './timed.js';
import { registerAuth } from './auth.js';
import { registerTreeRoutes } from './routes/tree.js';
import { registerFileRoutes } from './routes/file.js';
import { registerEventsRoute } from './routes/events.js';
import { registerPairRoutes } from './routes/pair.js';
import { registerTimedRoutes } from './routes/timed.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
const VERSION = pkg.version ?? '1.0.0';

/** 端口被占用时抛出（含端口号），由调用方决定提示方式；不自动换端口 */
export class PortInUseError extends Error {
  constructor(public port: number) {
    super(`端口 ${port} 已被占用`);
    this.name = 'PortInUseError';
  }
}

export interface StartServerOpts {
  /** 覆盖前端静态资源目录；缺省用 MDLIVE_WEB_DIST 环境变量，再缺省用项目根 web/dist */
  webDist?: string;
}

export interface RunningServer {
  port: number;
  /** 完整停服：SSE 全部结束 → app.close（3s 兜底）→ 关连接 → 关 watcher。不退出进程 */
  stop: () => Promise<void>;
  version: string;
  vault: string;
}

/** 启动完整服务（HTTP + SSE + watcher + timed），返回句柄。可被 CLI 与图形外壳共同使用 */
export async function startServer(opts?: StartServerOpts): Promise<RunningServer> {
  const { cfg, persist } = loadConfig((m) => log('info', m));
  const tokenFromEnv = !!process.env.MDLIVE_TOKEN;
  // forceCloseConnections：关服时把被 SSE hijack 的连接一并关闭，否则 app.close() 可能永不返回
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, forceCloseConnections: true });

  const vault = new Vault(cfg);
  const bus = new EventBus();
  vault.broadcast = (ev) => bus.broadcast(ev);
  const timed = new TimedVault(vault, () => {
    bus.broadcast({ kind: 'tree-changed' });
  });

  registerAuth(app, () => cfg.token);
  app.get('/api/health', async () => ({
    ok: true,
    vault: cfg.vault,
    version: VERSION,
    paired: cfg.token !== '',
  }));
  registerTreeRoutes(app, vault);
  registerFileRoutes(app, vault);
  registerEventsRoute(app, bus);
  registerTimedRoutes(app, timed);
  registerPairRoutes(app, {
    getToken: () => cfg.token,
    setToken: (code) => {
      cfg.token = code;
      persist();
      log('info', '配对码已在浏览器端设置完成');
    },
    tokenFromEnv,
    port: cfg.port,
    getPublicUrl: () => cfg.publicUrl,
    setPublicUrl: (url) => {
      cfg.publicUrl = url;
      persist();
      log('info', url === '' ? '已清除公网地址' : `公网地址已设置: ${url}`);
    },
  });

  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as Error & { statusCode?: number };
    if (rawErr instanceof HttpError) {
      return reply.code(rawErr.status).send(rawErr.payload);
    }
    const status = err.statusCode;
    if (typeof status === 'number' && status >= 400) {
      return reply.code(status).send({ error: err.message });
    }
    log('error', `${req.method} ${req.raw.url} -> 500: ${err.stack ?? String(rawErr)}`);
    return reply.code(500).send({ error: 'internal error' });
  });

  const webDist = opts?.webDist ?? process.env.MDLIVE_WEB_DIST ?? path.join(projectRoot(), 'web', 'dist');
  const hasWeb = fs.existsSync(path.join(webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDist, index: 'index.html' });
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '/';
    if (url.startsWith('/api/') || !hasWeb) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      // SPA fallback
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });

  const watcher = startWatcher(vault, cfg, (ev) => bus.broadcast(ev));

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    timed.stop();
    // 先主动结束所有 SSE 响应：被 hijack 且未 end 的连接不算 idle，会让 app.close() 挂起
    await bus.close();
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, 3000).unref()),
    ]);
    try {
      app.server.closeAllConnections();
    } catch {
      /* ignore */
    }
    try {
      await watcher.close();
    } catch {
      /* ignore */
    }
  };

  try {
    await app.listen({ port: cfg.port, host: '0.0.0.0' });
  } catch (e) {
    try {
      await watcher.close();
    } catch {
      /* ignore */
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' || code === 'EACCES') {
      throw new PortInUseError(cfg.port);
    }
    throw e;
  }
  timed.start();

  log(
    'info',
    `mdlive v${VERSION} 已启动 :${cfg.port} vault=${cfg.vault} 配对码=${cfg.token === '' ? '未设置' : '已设置'}`,
  );
  for (const ip of lanAddresses()) log('info', `  局域网: http://${ip}:${cfg.port}`);

  return { port: cfg.port, stop, version: VERSION, vault: cfg.vault };
}

let closing = false;
/** CLI 入口：node dist/index.js 直接运行时的包装 */
async function main(): Promise<void> {
  const server = await startServer();
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    log('info', '正在关闭…');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// 仅当被直接执行（node dist/index.js）时启动 CLI；被 import（图形外壳）时不自动跑
const isDirectRun =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return pathToFileURL(process.argv[1]).href === import.meta.url;
    } catch {
      return false;
    }
  })();
if (isDirectRun) {
  main().catch((e: unknown) => {
    if (e instanceof PortInUseError) {
      log('error', `启动失败: ${e.message}（请换端口或停止占用该端口的程序）`);
    } else {
      log('error', `启动失败: ${(e as Error).stack ?? String(e)}`);
    }
    process.exit(1);
  });
}
