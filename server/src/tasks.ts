import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './vault.js';
import { log } from './log.js';

export type TaskStatus = 'pending' | 'done';

/** 一条任务单：谁发起、谁确认、什么时候确认，都留在记录里 */
export interface TaskItem {
  id: string;
  /** 任务内容（纯文本，不做 Markdown 渲染） */
  title: string;
  note: string;
  status: TaskStatus;
  createdAt: number;
  /** 发起人昵称（设备自报，仅用于展示） */
  createdBy: string;
  /** 发起设备 id，用于判断「这条是不是我发的」 */
  createdById: string;
  doneAt: number | null;
  doneBy: string | null;
  doneById: string | null;
  updatedAt: number;
}

export interface TaskInput {
  title: unknown;
  note?: unknown;
  actor?: unknown;
  actorId?: unknown;
}

const MAX_ITEMS = 500;
const TITLE_MAX = 200;
const NOTE_MAX = 2000;
const ACTOR_MAX = 32;
const ID_MAX = 64;
const STORE_VERSION = 1;

/** 去掉控制字符（保留换行/制表），去首尾空白，按字符上限截断 */
function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function isItem(v: unknown): v is TaskItem {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.title === 'string' && (o.status === 'pending' || o.status === 'done');
}

/** 宽容地补全老版本/手工编辑过的记录，缺字段不炸 */
function normalize(v: TaskItem): TaskItem {
  const created = typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) ? v.createdAt : Date.now();
  const done = v.status === 'done';
  return {
    id: v.id,
    title: cleanText(v.title, TITLE_MAX),
    note: cleanText(v.note, NOTE_MAX),
    status: done ? 'done' : 'pending',
    createdAt: created,
    createdBy: cleanText(v.createdBy, ACTOR_MAX) || '未署名',
    createdById: cleanText(v.createdById, ID_MAX),
    doneAt: done && typeof v.doneAt === 'number' ? v.doneAt : null,
    doneBy: done ? cleanText(v.doneBy, ACTOR_MAX) || null : null,
    doneById: done ? cleanText(v.doneById, ID_MAX) || null : null,
    updatedAt: typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt) ? v.updatedAt : created,
  };
}

/**
 * 任务单存储：vault/.lanmd/tasks.json。
 * 放在 vault 内的点目录下，与 .timed 同理——文件树与 watcher 都跳过「.」开头的目录，
 * 且随 vault 一起迁移，不额外引入数据目录概念。
 */
export class TaskStore {
  private items: TaskItem[] | null = null;
  /** 写入串行化：读-改-写全程排队，避免并发请求互相覆盖 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private vaultRoot: string,
    private onChanged: () => void = () => {},
  ) {}

  private file(): string {
    return path.join(this.vaultRoot, '.lanmd', 'tasks.json');
  }

  private mutex<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async ensure(): Promise<TaskItem[]> {
    if (this.items) return this.items;
    let items: TaskItem[] = [];
    const raw = await fsp.readFile(this.file(), 'utf8').catch(() => null);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as { items?: unknown };
        if (Array.isArray(parsed.items)) items = parsed.items.filter(isItem).map(normalize);
      } catch (e) {
        log('error', `[tasks] tasks.json 解析失败，按空列表处理: ${(e as Error).message}`);
      }
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    this.items = items;
    return items;
  }

  private async save(): Promise<void> {
    const file = this.file();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const body = `${JSON.stringify({ version: STORE_VERSION, items: this.items ?? [] }, null, 2)}\n`;
    await fsp.writeFile(tmp, body, 'utf8');
    // Windows 上目标可能被杀软/索引占用，rename 报 EPERM 时小退避重试
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code === 'EPERM' || code === 'EACCES') && attempt < 8) {
          await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
          continue;
        }
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    }
  }

  /** 超出上限时丢弃最老的一条已完成记录；没有已完成才丢最老的任务 */
  private trim(items: TaskItem[]): void {
    while (items.length > MAX_ITEMS) {
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].status === 'done') {
          idx = i;
          break;
        }
      }
      items.splice(idx >= 0 ? idx : items.length - 1, 1);
    }
  }

  async list(): Promise<TaskItem[]> {
    return this.mutex(async () => [...(await this.ensure())]);
  }

  async create(input: TaskInput): Promise<TaskItem> {
    const title = cleanText(input.title, TITLE_MAX);
    if (!title) throw new HttpError(400, { error: '任务内容不能为空' });
    const note = cleanText(input.note, NOTE_MAX);
    const actor = cleanText(input.actor, ACTOR_MAX) || '未署名';
    const actorId = cleanText(input.actorId, ID_MAX);
    return this.mutex(async () => {
      const items = await this.ensure();
      const now = Date.now();
      const item: TaskItem = {
        id: crypto.randomBytes(6).toString('hex'),
        title,
        note,
        status: 'pending',
        createdAt: now,
        createdBy: actor,
        createdById: actorId,
        doneAt: null,
        doneBy: null,
        doneById: null,
        updatedAt: now,
      };
      items.unshift(item);
      this.trim(items);
      await this.save();
      log('info', `[tasks] 新增 ${item.id} by ${actor}: ${title.slice(0, 40)}`);
      this.onChanged();
      return item;
    });
  }

  /** 确认执行 / 撤销执行。同一状态重复提交是幂等的，不改时间戳 */
  async setStatus(id: unknown, status: unknown, actorRaw: unknown, actorIdRaw: unknown): Promise<TaskItem> {
    if (typeof id !== 'string' || !id) throw new HttpError(400, { error: '缺少任务 id' });
    if (status !== 'pending' && status !== 'done') {
      throw new HttpError(400, { error: 'status 只能是 pending 或 done' });
    }
    const next: TaskStatus = status;
    const actor = cleanText(actorRaw, ACTOR_MAX) || '未署名';
    const actorId = cleanText(actorIdRaw, ID_MAX);
    return this.mutex(async () => {
      const items = await this.ensure();
      const item = items.find((x) => x.id === id);
      if (!item) throw new HttpError(404, { error: '任务不存在' });
      if (item.status === next) return item;
      const now = Date.now();
      item.status = next;
      item.updatedAt = now;
      if (next === 'done') {
        item.doneAt = now;
        item.doneBy = actor;
        item.doneById = actorId;
      } else {
        item.doneAt = null;
        item.doneBy = null;
        item.doneById = null;
      }
      await this.save();
      log('info', `[tasks] ${next === 'done' ? '确认' : '撤销'} ${item.id} by ${actor}`);
      this.onChanged();
      return item;
    });
  }

  async remove(id: unknown): Promise<void> {
    if (typeof id !== 'string' || !id) throw new HttpError(400, { error: '缺少任务 id' });
    await this.mutex(async () => {
      const items = await this.ensure();
      const idx = items.findIndex((x) => x.id === id);
      if (idx < 0) throw new HttpError(404, { error: '任务不存在' });
      const [gone] = items.splice(idx, 1);
      await this.save();
      log('info', `[tasks] 删除 ${gone.id}`);
      this.onChanged();
    });
  }
}
