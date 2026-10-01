import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './config.js';
import type { Vault } from './vault.js';
import type { BusEvent } from './types.js';
import { log } from './log.js';

const DEBOUNCE_MS = 200;

export function startWatcher(vault: Vault, cfg: Config, emit: (ev: BusEvent) => void): FSWatcher {
  const root = vault.root;
  const ci = process.platform === 'win32';
  const ignoreNames = new Set(cfg.ignore.map((n) => (ci ? n.toLowerCase() : n)));
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const isIgnoredPath = (p: string): boolean => {
    const rel = path.relative(root, p);
    if (rel === '') return false; // watch 根本身
    const segs = rel.split(path.sep);
    if (segs.some((s) => s.startsWith('.') || ignoreNames.has(ci ? s.toLowerCase() : s))) return true;
    if (/\.tmp-/.test(segs[segs.length - 1])) return true; // 原子写的临时文件
    return false;
  };

  const isMd = (p: string) => p.toLowerCase().endsWith('.md');

  const handleUpsert = async (abs: string) => {
    if (!isMd(abs)) return;
    let content: string;
    try {
      content = await fsp.readFile(abs, 'utf8');
    } catch {
      return; // 事件到达时文件已消失，等 unlink 事件
    }
    const hash = crypto.createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 12);
    if (vault.suppressSelf(abs, 'change', hash)) {
      log('debug', `[watcher] 丢弃自身写盘回声: ${vault.toRel(abs)} (${hash})`);
      return;
    }
    const st = await fsp.stat(abs).catch(() => null);
    const mtime = st ? st.mtimeMs : Date.now();
    log('info', `[watcher] 外部修改: ${vault.toRel(abs)} -> ${hash}`);
    emit({ kind: 'file-changed', path: vault.toRel(abs), version: hash, mtime });
    emit({ kind: 'tree-changed' });
  };

  const handleUnlink = (abs: string) => {
    if (!isMd(abs)) return;
    if (vault.suppressSelf(abs, 'unlink')) {
      log('debug', `[watcher] 丢弃自身删除回声: ${vault.toRel(abs)}`);
      return;
    }
    log('info', `[watcher] 外部删除: ${vault.toRel(abs)}`);
    emit({ kind: 'file-removed', path: vault.toRel(abs) });
    emit({ kind: 'tree-changed' });
  };

  const debounced = (abs: string, fn: () => void) => {
    const old = debounceTimers.get(abs);
    if (old) clearTimeout(old);
    debounceTimers.set(
      abs,
      setTimeout(() => {
        debounceTimers.delete(abs);
        fn();
      }, DEBOUNCE_MS),
    );
  };

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: (p: string) => isIgnoredPath(p),
  });

  watcher.on('add', (p) => debounced(p, () => void handleUpsert(path.resolve(p))));
  watcher.on('change', (p) => debounced(p, () => void handleUpsert(path.resolve(p))));
  watcher.on('unlink', (p) => debounced(p, () => handleUnlink(path.resolve(p))));
  watcher.on('error', (e) => log('error', `[watcher] 错误: ${(e as Error).message}`));

  return watcher;
}
