import type { ServerResponse } from 'node:http';
import type { BusEvent } from './types.js';
import { log } from './log.js';

export const MAX_CLIENTS = 64;

interface Client {
  id: number;
  res: ServerResponse;
}

export class EventBus {
  private clients = new Map<number, Client>();
  private nextId = 1;
  private keepalive: NodeJS.Timeout;

  constructor() {
    this.keepalive = setInterval(() => {
      this.writeAll(': keepalive\n\n');
    }, 25_000);
    this.keepalive.unref(); // 不阻止进程退出
  }

  count(): number {
    return this.clients.size;
  }

  add(res: ServerResponse): number {
    const id = this.nextId++;
    this.clients.set(id, { id, res });
    // TCP 层 keepalive：手机断网等半开连接能在几十秒内被内核探测到并触发 error/close 清理
    res.socket?.setKeepAlive(true, 10_000);
    res.on('close', () => this.remove(id, 'client closed'));
    res.on('error', () => this.remove(id, 'client error'));
    log('info', `[sse] 连接建立 #${id}（在线 ${this.clients.size}）`);
    return id;
  }

  private remove(id: number, why: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    this.clients.delete(id);
    log('info', `[sse] 连接断开 #${id}（${why}，在线 ${this.clients.size}）`);
    try {
      c.res.end();
    } catch {
      /* ignore */
    }
  }

  private writeAll(chunk: string): void {
    for (const c of [...this.clients.values()]) {
      if (c.res.destroyed || c.res.writableEnded) {
        this.remove(c.id, 'dead socket');
        continue;
      }
      try {
        // 背压保护：对端失联导致写缓冲堆积时直接断开
        if (c.res.writableLength > 1_000_000) {
          this.remove(c.id, 'backpressure');
          continue;
        }
        c.res.write(chunk);
      } catch {
        this.remove(c.id, 'write failed');
      }
    }
  }

  broadcast(ev: BusEvent): void {
    const { kind, ...data } = ev;
    const payload = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    log('info', `[sse] 广播 ${kind} ${'path' in data ? data.path : ''}`);
    this.writeAll(payload);
  }

  async close(): Promise<void> {
    clearInterval(this.keepalive);
    for (const c of [...this.clients.values()]) this.remove(c.id, 'server shutdown');
  }
}
