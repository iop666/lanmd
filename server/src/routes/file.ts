import type { FastifyInstance } from 'fastify';
import { HttpError, type Vault } from '../vault.js';

export function registerFileRoutes(app: FastifyInstance, vault: Vault): void {
  app.get('/api/file', async (req) => {
    const p = (req.query as Record<string, unknown> | undefined)?.path;
    if (typeof p !== 'string') throw new HttpError(400, { error: 'missing path' });
    return vault.read(p);
  });

  app.put('/api/file', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = body.path;
    if (typeof p !== 'string') throw new HttpError(400, { error: 'missing path' });
    return vault.write(p, body.content, body.baseVersion ?? null);
  });

  app.delete('/api/file', async (req) => {
    const p = (req.query as Record<string, unknown> | undefined)?.path;
    if (typeof p !== 'string') throw new HttpError(400, { error: 'missing path' });
    await vault.remove(p);
    return { ok: true };
  });

  app.post('/api/file/rename', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const from = body.from;
    const to = body.to;
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new HttpError(400, { error: 'from/to required' });
    }
    await vault.rename(from, to);
    return { ok: true };
  });

  app.post('/api/file/mkdir', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = body.path;
    if (typeof p !== 'string') throw new HttpError(400, { error: 'missing path' });
    await vault.mkdir(p);
    return { ok: true };
  });
}
