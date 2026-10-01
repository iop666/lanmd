import type { FastifyInstance } from 'fastify';
import { EventBus, MAX_CLIENTS } from '../events.js';

export function registerEventsRoute(app: FastifyInstance, bus: EventBus): void {
  app.get('/api/events', async (req, reply) => {
    if (bus.count() >= MAX_CLIENTS) {
      return reply.code(503).send({ error: 'too many sse connections' });
    }
    // 劫持响应，手工写 SSE 流；连接生命周期由 EventBus 监听 res close/error 管理
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write(': hello\n\n');
    bus.add(raw);
  });
}
