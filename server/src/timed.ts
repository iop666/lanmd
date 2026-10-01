import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Vault } from './vault.js';
import { log } from './log.js';

export interface TimedSlotInfo {
  id: string;
  label: string;
  /** vault 内相对路径 */
  path: string;
  durationMs: number;
  exists: boolean;
  /** 距自动删除的剩余毫秒；槽为空时为 null */
  remainingMs: number | null;
  mtime: number | null;
  size: number | null;
}

export interface TimedSlotDef {
  id: string;
  label: string;
  durationMs: number;
}

const MIN = 60_000;
export const TIMED_SLOTS: TimedSlotDef[] = [
  { id: '1h-1', label: '1小时·A', durationMs: 60 * MIN },
  { id: '1h-2', label: '1小时·B', durationMs: 60 * MIN },
  { id: '30m-1', label: '30分钟·A', durationMs: 30 * MIN },
  { id: '30m-2', label: '30分钟·B', durationMs: 30 * MIN },
  { id: '10m-1', label: '10分钟·A', durationMs: 10 * MIN },
  { id: '10m-2', label: '10分钟·B', durationMs: 10 * MIN },
];

const SWEEP_INTERVAL_MS = 15_000;

/**
 * 倒计时暂存库：vault/.timed/ 下 6 个固定槽文件。
 * 槽内文件的 mtime 是倒计时基准（任何端编辑/写入都会刷新），到期自动删除。
 * .timed 以点开头，天然被文件树与 watcher 忽略，不影响正式库。
 */
export class TimedVault {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private vault: Vault,
    private onDelete: (absPath: string) => void = () => {},
  ) {}

  slotPath(id: string): string {
    return `.timed/${id}.md`;
  }

  async snapshot(): Promise<TimedSlotInfo[]> {
    const dir = path.join(this.vault.root, '.timed');
    await fsp.mkdir(dir, { recursive: true });
    const now = Date.now();
    const out: TimedSlotInfo[] = [];
    for (const def of TIMED_SLOTS) {
      const rel = this.slotPath(def.id);
      const abs = path.join(dir, `${def.id}.md`);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isFile()) {
        out.push({ id: def.id, label: def.label, path: rel, durationMs: def.durationMs, exists: false, remainingMs: null, mtime: null, size: null });
        continue;
      }
      const remain = st.mtimeMs + def.durationMs - now;
      if (remain <= 0) {
        await this.removeSlot(abs, def.label);
        out.push({ id: def.id, label: def.label, path: rel, durationMs: def.durationMs, exists: false, remainingMs: null, mtime: null, size: null });
        continue;
      }
      out.push({
        id: def.id,
        label: def.label,
        path: rel,
        durationMs: def.durationMs,
        exists: true,
        remainingMs: remain,
        mtime: st.mtimeMs,
        size: st.size,
      });
    }
    return out;
  }

  private async removeSlot(abs: string, label: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rm(abs);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code === 'EPERM' || code === 'EACCES') && attempt < 4) {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
        log('error', `[timed] 删除过期槽失败 ${label}: ${(e as Error).message}`);
        return;
      }
    }
    log('info', `[timed] 到期自动删除: ${label} (${this.vault.toRel(abs)})`);
    this.onDelete(abs);
  }

  start(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.snapshot();
    } catch {
      /* ignore */
    } finally {
      this.sweeping = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
