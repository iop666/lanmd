import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { lanAddresses } from '../lan.js';

interface PairDeps {
  getToken: () => string;
  /** 首次设置配对码：写入 cfg.token 并持久化到 config.json */
  setToken: (code: string) => void;
  /** 环境变量注入的 token 时不允许 setup */
  tokenFromEnv: boolean;
  port: number;
}

const eq = (a: string, b: string): boolean => {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
};

function validCode(code: unknown): code is string {
  if (typeof code !== 'string') return false;
  const c = code.trim();
  return c.length >= 1 && c.length <= 128 && !/[\0-\x1f]/.test(c);
}

export function registerPairRoutes(app: FastifyInstance, deps: PairDeps): void {
  // 简单限速：同 IP 每分钟最多 10 次尝试，抑制局域网内爆破
  const attempts = new Map<string, { n: number; t: number }>();
  const throttle = (ip: string): boolean => {
    const now = Date.now();
    const rec = attempts.get(ip);
    if (!rec || now - rec.t > 60_000) {
      attempts.set(ip, { n: 1, t: now });
      return false;
    }
    rec.n++;
    return rec.n > 10;
  };

  // 首次配对：仅在服务端尚未设置配对码时可用，浏览器里完成设置
  app.post('/api/setup-pin', async (req, reply) => {
    if (deps.getToken() !== '' || deps.tokenFromEnv) {
      return reply.code(403).send({ error: 'pin already set' });
    }
    if (throttle(req.ip)) return reply.code(429).send({ error: 'too many attempts' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!validCode(body.code)) {
      return reply.code(400).send({ error: '配对码需为 1-128 个可见字符' });
    }
    const code = (body.code as string).trim();
    deps.setToken(code);
    return { token: code };
  });

  app.post('/api/pair', async (req, reply) => {
    if (throttle(req.ip)) return reply.code(429).send({ error: 'too many attempts' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = body.code;
    if (!validCode(code)) {
      return reply.code(401).send({ error: 'invalid code' });
    }
    const token = deps.getToken();
    if (token === '' || !eq((code as string).trim(), token)) {
      return reply.code(401).send({ error: 'invalid code' });
    }
    return { token };
  });

  // 已配对设备查询连接信息：局域网地址 + 含配对码的二维码
  app.get('/api/connect-info', async () => {
    const token = deps.getToken();
    const urls = lanAddresses().map((ip) => `http://${ip}:${deps.port}`);
    let qr: string | null = null;
    if (urls.length > 0 && token !== '') {
      try {
        const qrcode = (await import('qrcode')).default;
        qr = await qrcode.toDataURL(`${urls[0]}/?token=${encodeURIComponent(token)}`, {
          margin: 1,
          scale: 6,
        });
      } catch {
        qr = null;
      }
    }
    return { urls, qr };
  });
}
