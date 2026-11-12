import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TaskStore } from '../tasks.js';
import { HttpError } from '../vault.js';

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  if (typeof b !== 'object' || b === null) throw new HttpError(400, { error: '缺少请求体' });
  return b as Record<string, unknown>;
}

export function registerTaskRoutes(app: FastifyInstance, tasks: TaskStore): void {
  app.get('/api/tasks', async () => ({ items: await tasks.list() }));

  app.post('/api/tasks', async (req) => {
    const b = bodyOf(req);
    const item = await tasks.create({
      title: b.title,
      note: b.note,
      actor: b.actor,
      actorId: b.actorId,
    });
    return { item };
  });

  // 确认执行 / 撤销执行都走这里：status = done | pending
  app.post('/api/tasks/status', async (req) => {
    const b = bodyOf(req);
    const item = await tasks.setStatus(b.id, b.status, b.actor, b.actorId);
    return { item };
  });

  app.delete('/api/tasks', async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    await tasks.remove(q.id);
    return { ok: true };
  });
}
