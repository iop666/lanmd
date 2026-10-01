import type { FastifyInstance } from 'fastify';
import type { Vault } from '../vault.js';

export function registerTreeRoutes(app: FastifyInstance, vault: Vault): void {
  app.get('/api/tree', async () => {
    const items = await vault.tree();
    return { items };
  });
}
