const TOKEN_KEY = 'mdlive.token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ---------- 设备身份（任务单里区分「谁发起 / 谁确认」） ----------
const DEVICE_ID_KEY = 'lanmd.deviceId';
const DEVICE_NAME_KEY = 'lanmd.deviceName';

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 稳定设备 id：localStorage 里有就复用，没有就生成 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = randomHex(6);
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return '安卓手机';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return '电脑';
  return '设备';
}

export function getDeviceName(): string {
  const n = localStorage.getItem(DEVICE_NAME_KEY);
  if (n && n.trim()) return n.trim();
  const d = guessDeviceName();
  localStorage.setItem(DEVICE_NAME_KEY, d);
  return d;
}

export function setDeviceName(name: string): void {
  const n = name.trim().slice(0, 16);
  if (n) localStorage.setItem(DEVICE_NAME_KEY, n);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

interface ReqOpts {
  keepalive?: boolean;
  noToken?: boolean;
}

async function request<T>(method: string, url: string, body?: unknown, opts?: ReqOpts): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getStoredToken();
  // HTTP header 值只允许 ISO-8859-1：中文配对码必须先百分号编码，服务端做对应解码
  if (token && !opts?.noToken) headers['Authorization'] = `Bearer ${encodeURIComponent(token)}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    keepalive: opts?.keepalive,
  });
  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, payload);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  mtime: number;
  children?: TreeNode[];
}

export interface FileResp {
  content: string;
  version: string;
  mtime: number;
}

export interface WriteResp {
  version: string;
  mtime: number;
}

export interface HealthResp {
  ok: true;
  vault: string;
  version: string;
  paired: boolean;
}

export interface ConnectInfo {
  urls: string[];
  qr: string | null;
  publicUrl: string;
}

export interface TimedSlot {
  id: string;
  label: string;
  path: string;
  durationMs: number;
  exists: boolean;
  remainingMs: number | null;
  mtime: number | null;
  size: number | null;
}

export type TaskStatus = 'pending' | 'done';

/** 一条任务单：发起方发布，执行方点「已执行」，状态实时回到发起方屏幕 */
export interface TaskItem {
  id: string;
  title: string;
  note: string;
  status: TaskStatus;
  createdAt: number;
  createdBy: string;
  createdById: string;
  doneAt: number | null;
  doneBy: string | null;
  doneById: string | null;
  updatedAt: number;
}

export const api = {
  health: () => request<HealthResp>('GET', '/api/health', undefined, { noToken: true }),
  pair: (code: string) => request<{ token: string }>('POST', '/api/pair', { code }, { noToken: true }),
  setupPin: (code: string) => request<{ token: string }>('POST', '/api/setup-pin', { code }, { noToken: true }),
  connectInfo: () => request<ConnectInfo>('GET', '/api/connect-info'),
  setPublicUrl: (url: string) =>
    request<{ ok: true; publicUrl: string }>('POST', '/api/public-url', { url }),
  tree: () => request<{ items: TreeNode[] }>('GET', '/api/tree'),
  getFile: (path: string) => request<FileResp>('GET', `/api/file?path=${enc(path)}`),
  putFile: (path: string, content: string, baseVersion: string | null, keepalive = false) =>
    request<WriteResp>('PUT', '/api/file', { path, content, baseVersion }, { keepalive }),
  deleteFile: (path: string) => request<{ ok: true }>('DELETE', `/api/file?path=${enc(path)}`),
  rename: (from: string, to: string) => request<{ ok: true }>('POST', '/api/file/rename', { from, to }),
  mkdir: (path: string) => request<{ ok: true }>('POST', '/api/file/mkdir', { path }),
  timed: () => request<{ items: TimedSlot[] }>('GET', '/api/timed'),
  tasks: () => request<{ items: TaskItem[] }>('GET', '/api/tasks'),
  createTask: (title: string, note: string) =>
    request<{ item: TaskItem }>('POST', '/api/tasks', {
      title,
      note,
      actor: getDeviceName(),
      actorId: getDeviceId(),
    }),
  setTaskStatus: (id: string, status: TaskStatus) =>
    request<{ item: TaskItem }>('POST', '/api/tasks/status', {
      id,
      status,
      actor: getDeviceName(),
      actorId: getDeviceId(),
    }),
  deleteTask: (id: string) => request<{ ok: true }>('DELETE', `/api/tasks?id=${enc(id)}`),
};
