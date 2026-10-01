import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export function extractToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const raw = auth.slice(7);
    // 前端对非 ASCII 配对码做了百分号编码；ASCII 值解码后原样不变
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof q === 'string' && q !== '') return q;
  return null;
}

/** getToken 动态读取：配对码可在运行中被首次设置 */
export function registerAuth(app: FastifyInstance, getToken: () => string): void {
  const matches = (t: string): boolean => {
    const token = getToken();
    if (token === '') return false;
    const ha = crypto.createHash('sha256').update(t, 'utf8').digest();
    const hb = crypto.createHash('sha256').update(token, 'utf8').digest();
    return crypto.timingSafeEqual(ha, hb);
  };

  app.addHook('onRequest', async (req, reply) => {
    const url = (req.raw.url ?? '').split('?')[0];
    if (!url.startsWith('/api/')) return; // 静态资源不鉴权
    if (url === '/api/health' || url === '/api/pair' || url === '/api/setup-pin') return;
    const t = extractToken(req);
    if (!t || !matches(t)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
