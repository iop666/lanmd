import type { FastifyInstance } from 'fastify';
import type { TimedVault } from '../timed.js';

export function registerTimedRoutes(app: FastifyInstance, timed: TimedVault): void {
  app.get('/api/timed', async () => {
    return { items: await timed.snapshot() };
  });
}
