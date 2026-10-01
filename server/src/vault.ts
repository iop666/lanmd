import fsp from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './config.js';
import { log } from './log.js';
import type { BusEvent } from './types.js';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  mtime: number;
  children?: TreeNode[];
}

export interface FileData {
  content: string;
  version: string;
  mtime: number;
}

export interface WriteResult {
  version: string;
  mtime: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public payload: Record<string, unknown>,
  ) {
    super(String(payload.error ?? status));
  }
}

export function sha12(s: string): string {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12);
}

type PendingOp = { kind: 'write'; hash: string; at: number } | { kind: 'delete'; at: number };

const PENDING_TTL = 3000;

export class Vault {
  readonly root: string;
  /** 由 index.ts 注入：写入后广播给 SSE 客户端 */
  broadcast: ((ev: BusEvent) => void) | null = null;

  /** 本服务即将写盘内容的记录，用于抑制 chokidar 回声 */
  private pending = new Map<string, PendingOp>();
  /** 全局写互斥队列：同一时刻只做一个变更操作，消除 check-then-write 竞态 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private cfg: Config) {
    this.root = path.resolve(cfg.vault);
  }

  private normKey(abs: string): string {
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

  /** 防止抑制记录 Map 无限增长：超阈值时清理过期项 */
  private prunePending(): void {
    if (this.pending.size < 256) return;
    const now = Date.now();
    for (const [k, op] of this.pending) {
      if (now - op.at > PENDING_TTL) this.pending.delete(k);
    }
  }

  /** 校验并解析相对路径；任何逃逸尝试抛 400。返回 vault 内绝对路径（未做 realpath）。 */
  resolveSafe(rel: unknown): string {
    if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) {
      throw new HttpError(400, { error: 'bad path' });
    }
    if (rel.includes('\0')) throw new HttpError(400, { error: 'bad path' });
    // 反斜杠一律拒绝：Windows 上它是分隔符，可用于构造 ..\ 逃逸
    if (rel.includes('\\')) throw new HttpError(400, { error: 'path must use / separators' });
    if (rel.startsWith('/')) throw new HttpError(400, { error: 'absolute path not allowed' });
    if (/^[a-zA-Z]:/.test(rel)) throw new HttpError(400, { error: 'drive path not allowed' });
    const abs = path.resolve(this.root, rel);
    const r = path.relative(this.root, abs);
    if (r === '' || r.startsWith('..') || path.isAbsolute(r)) {
      throw new HttpError(400, { error: 'path escapes vault' });
    }
    return abs;
  }

  /** 在 resolveSafe 基础上做 realpath 包含性校验，拒绝符号链接逃逸。 */
  async resolveSafeReal(rel: unknown): Promise<string> {
    const abs = this.resolveSafe(rel);
    await this.assertInsideReal(abs);
    return abs;
  }

  private async assertInsideReal(abs: string): Promise<void> {
    let rootReal: string;
    try {
      rootReal = await fsp.realpath(this.root);
    } catch {
      return; // vault 本身无法解析时放弃该层检查
    }
    let probe = abs;
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        const relr = path.relative(rootReal, real);
        if (relr.startsWith('..') || path.isAbsolute(relr)) {
          throw new HttpError(400, { error: 'symlink escapes vault' });
        }
        return;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          const parent = path.dirname(probe);
          if (parent === probe) return;
          probe = parent;
          continue;
        }
        throw e;
      }
    }
  }

  toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  async read(rel: string): Promise<FileData> {
    const abs = await this.resolveSafeReal(rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new HttpError(404, { error: 'file not found' });
    const content = await fsp.readFile(abs, 'utf8');
    return { content, version: sha12(content), mtime: st.mtimeMs };
  }

  private mutex<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async write(rel: string, content: unknown, baseVersion: unknown): Promise<WriteResult> {
    if (typeof content !== 'string') throw new HttpError(400, { error: 'content must be a string' });
    if (baseVersion !== null && typeof baseVersion !== 'string') {
      throw new HttpError(400, { error: 'baseVersion must be a string or null' });
    }
    const abs = await this.resolveSafeReal(rel);
    return this.mutex(async () => {
      await this.assertInsideReal(abs);
      const st = await fsp.stat(abs).catch(() => null);
      if (st && !st.isFile()) throw new HttpError(400, { error: 'target is a directory' });
      let curVersion: string | null = null;
      let curContent = '';
      if (st && st.isFile()) {
        curContent = await fsp.readFile(abs, 'utf8');
        curVersion = sha12(curContent);
      }
      if (curVersion !== null) {
        if (baseVersion === null || baseVersion !== curVersion) {
          throw new HttpError(409, { error: 'conflict', currentVersion: curVersion, content: curContent });
        }
      } else if (baseVersion !== null) {
        // 想更新的文件已不存在（被外部删除）
        throw new HttpError(409, { error: 'conflict', currentVersion: null, content: '' });
      }
      const version = sha12(content);
      const relp = this.toRel(abs);
      // 父目录不存在则自动创建（resolveSafe 已保证路径在 vault 内）
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      // 记录即将写入的 hash，供 watcher 抑制回声
      this.markWrite(abs, version);
      const mtime = await this.atomicWrite(abs, content);
      log('info', `[write] ${relp} -> ${version}`);
      this.broadcast?.({ kind: 'file-changed', path: relp, version, mtime });
      this.broadcast?.({ kind: 'tree-changed' });
      return { version, mtime };
    });
  }

  async remove(rel: string): Promise<void> {
    const abs = await this.resolveSafeReal(rel);
    await this.mutex(async () => {
      await this.assertInsideReal(abs);
      const st = await fsp.lstat(abs).catch(() => null);
      if (!st) throw new HttpError(404, { error: 'file not found' });
      if (!st.isFile()) throw new HttpError(400, { error: 'not a file' });
      this.markDelete(abs);
      // Windows 上目标可能被编辑器/杀软占用，EPERM 时小退避重试
      for (let attempt = 0; ; attempt++) {
        try {
          await fsp.rm(abs);
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if ((code === 'EPERM' || code === 'EACCES') && attempt < 8) {
            await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
      const relp = this.toRel(abs);
      log('info', `[delete] ${relp}`);
      this.broadcast?.({ kind: 'file-removed', path: relp });
      this.broadcast?.({ kind: 'tree-changed' });
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const fromAbs = await this.resolveSafeReal(from);
    const toAbs = await this.resolveSafeReal(to);
    await this.mutex(async () => {
      if (fromAbs === toAbs) return;
      await this.assertInsideReal(fromAbs);
      await this.assertInsideReal(toAbs);
      const st = await fsp.lstat(fromAbs).catch(() => null);
      if (!st) throw new HttpError(404, { error: 'source not found' });
      if (!st.isFile()) throw new HttpError(400, { error: 'source is not a file' });
      const stTo = await fsp.lstat(toAbs).catch(() => null);
      if (stTo) throw new HttpError(409, { error: 'target exists' });
      const content = await fsp.readFile(fromAbs, 'utf8');
      const hash = sha12(content);
      await fsp.mkdir(path.dirname(toAbs), { recursive: true });
      this.markDelete(fromAbs);
      this.markWrite(toAbs, hash);
      await fsp.rename(fromAbs, toAbs);
      const relFrom = this.toRel(fromAbs);
      const relTo = this.toRel(toAbs);
      log('info', `[rename] ${relFrom} -> ${relTo}`);
      const stNew = await fsp.stat(toAbs).catch(() => null);
      this.broadcast?.({ kind: 'file-removed', path: relFrom });
      if (stNew) {
        this.broadcast?.({ kind: 'file-changed', path: relTo, version: hash, mtime: stNew.mtimeMs });
      }
      this.broadcast?.({ kind: 'tree-changed' });
    });
  }

  async mkdir(rel: string): Promise<void> {
    const abs = await this.resolveSafeReal(rel);
    await this.mutex(async () => {
      await this.assertInsideReal(abs);
      const st = await fsp.lstat(abs).catch(() => null);
      if (st) {
        if (st.isDirectory()) return; // 幂等
        throw new HttpError(409, { error: 'a file with this name already exists' });
      }
      await fsp.mkdir(abs, { recursive: true });
      log('info', `[mkdir] ${this.toRel(abs)}`);
      this.broadcast?.({ kind: 'tree-changed' });
    });
  }

  async tree(): Promise<TreeNode[]> {
    const ci = process.platform === 'win32';
    const ignore = new Set(this.cfg.ignore.map((n) => (ci ? n.toLowerCase() : n)));
    const walk = async (absDir: string, relDir: string): Promise<TreeNode[]> => {
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(absDir, { withFileTypes: true });
      } catch {
        return [];
      }
      const out: TreeNode[] = [];
      for (const e of entries) {
        const name = e.name;
        if (name.startsWith('.')) continue;
        const abs = path.join(absDir, name);
        const rel = relDir ? `${relDir}/${name}` : name;
        if (e.isDirectory()) {
          if (ignore.has(ci ? name.toLowerCase() : name)) continue;
          const children = await walk(abs, rel);
          out.push({ name, path: rel, type: 'dir', mtime: 0, children });
        } else if (e.isFile() && name.toLowerCase().endsWith('.md')) {
          const st = await fsp.stat(abs).catch(() => null);
          out.push({ name, path: rel, type: 'file', mtime: st ? st.mtimeMs : 0 });
        }
      }
      out.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
      return out;
    };
    return walk(this.root, '');
  }

  /** watcher 回调调用：判断该事件是否为本服务自己写盘的回声（3 秒窗口 + hash 匹配）。 */
  suppressSelf(absPath: string, kind: 'change' | 'unlink', currentHash?: string): boolean {
    const key = this.normKey(absPath);
    const op = this.pending.get(key);
    if (!op) return false;
    if (Date.now() - op.at > PENDING_TTL) {
      this.pending.delete(key);
      return false;
    }
    if (op.kind === 'delete') return kind === 'unlink';
    if (kind === 'unlink') return false;
    return currentHash !== undefined && currentHash === op.hash;
  }

  private markWrite(abs: string, hash: string): void {
    this.prunePending();
    this.pending.set(this.normKey(abs), { kind: 'write', hash, at: Date.now() });
  }

  private markDelete(abs: string): void {
    this.prunePending();
    this.pending.set(this.normKey(abs), { kind: 'delete', at: Date.now() });
  }

  private async atomicWrite(abs: string, content: string): Promise<number> {
    const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
    try {
      await fsp.writeFile(tmp, content, 'utf8');
      // Windows 上目标可能被编辑器/杀软短暂占用，rename 报 EPERM 时小退避重试
      for (let attempt = 0; ; attempt++) {
        try {
          await fsp.rename(tmp, abs);
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if ((code === 'EPERM' || code === 'EACCES') && attempt < 8) {
            await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    const st = await fsp.stat(abs);
    return st.mtimeMs;
  }
}
