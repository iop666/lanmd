import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  clearToken,
  getStoredToken,
  storeToken,
  type FileResp,
  type TimedSlot,
  type TreeNode,
} from './api';
import { connectEvents, type ConnState } from './sse';
import { copyText } from './copy';
import { markdownToPlainText } from './md';
import FileTree from './components/FileTree';
import Editor from './components/Editor';
import Preview from './components/Preview';
import StatusBar from './components/StatusBar';
import Connect from './components/Connect';
import ConnectInfo from './components/ConnectInfo';
import TimedPanel from './components/TimedPanel';
import Icon from './components/Icon';

interface OpenFile {
  path: string;
  /** 服务器上已确认内容的版本 */
  version: string;
  /** 与 version 对应的内容 */
  savedContent: string;
  mtime: number;
  dirty: boolean;
}

interface RemoteChange {
  version: string | null;
  content: string;
}

interface ConflictState {
  path: string;
  remoteVersion: string | null;
  remoteContent: string;
  myContent: string;
}

type SavePhase = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

function sanitizeName(raw: string): string {
  const name = raw.trim();
  if (!name || name === '.' || name === '..') return '';
  if (/[/\\]/.test(name)) return '';
  if (/[\0-\x1f]/.test(name)) return '';
  return name;
}

/** 文件树与监听只认 .md：新建/重命名时用户没写后缀就自动补上，避免产生界面上不可见的文件 */
function withMdSuffix(name: string): string {
  return /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
}

function filterTree(items: TreeNode[], q: string): TreeNode[] {
  if (!q) return items;
  const out: TreeNode[] = [];
  for (const it of items) {
    if (it.type === 'file') {
      if (it.name.toLowerCase().includes(q)) out.push(it);
    } else {
      const kids = filterTree(it.children ?? [], q);
      if (kids.length > 0 || it.name.toLowerCase().includes(q)) {
        out.push({ ...it, children: kids });
      }
    }
  }
  return out;
}

function diffSummary(mine: string, remote: string): { mine: string; remote: string; excerpt: string } {
  const ml = mine.split('\n');
  const rl = remote.split('\n');
  let i = 0;
  const min = Math.min(ml.length, rl.length);
  while (i < min && ml[i] === rl[i]) i++;
  const lines: string[] = [];
  if (ml[i] !== undefined) lines.push(`- ${ml[i]}`);
  if (rl[i] !== undefined) lines.push(`+ ${rl[i]}`);
  return {
    mine: `${ml.length} 行`,
    remote: `${rl.length} 行`,
    excerpt: lines.join('\n').slice(0, 400) || '（无差异预览）',
  };
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [conn, setConn] = useState<ConnState>('connecting');
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [current, setCurrent] = useState<OpenFile | null>(null);
  const [editorValue, setEditorValue] = useState('');
  const [previewSrc, setPreviewSrc] = useState('');
  const [savePhase, setSavePhase] = useState<SavePhase>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [remoteChange, setRemoteChange] = useState<RemoteChange | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [fileDeleted, setFileDeleted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pane, setPane] = useState<'edit' | 'preview'>('edit');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  const [connectInfo, setConnectInfo] = useState<{ firstTime: boolean } | null>(null);
  const [showTimed, setShowTimed] = useState(false);
  const [timedSlots, setTimedSlots] = useState<TimedSlot[]>([]);
  const [timedFetchedAt, setTimedFetchedAt] = useState(0);
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const importFolderRef = useRef<HTMLInputElement | null>(null);

  // 所有 SSE / 定时器回调通过 ref 读取最新状态，避免闭包过期
  const currentRef = useRef<OpenFile | null>(null);
  const latestContentRef = useRef('');
  const lastSaveRef = useRef<{ path: string; content: string; at: number } | null>(null);
  const openSeq = useRef(0);
  const remoteSeq = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  const treeTimer = useRef<number | undefined>(undefined);
  // 保存串行化状态
  const savingRef = useRef(false);
  const pendingPutRef = useRef<{ path: string; content: string } | null>(null);
  const resaveRef = useRef(false);
  const doSaveRef = useRef<(opts?: { keepalive?: boolean }) => Promise<void>>(async () => {});

  const setCur = (next: OpenFile | null): void => {
    currentRef.current = next;
    setCurrent(next);
  };
  const mutateCur = (fn: (c: OpenFile) => OpenFile): void => {
    const c = currentRef.current;
    if (c) setCur(fn(c));
  };

  // ---------- 文件树 ----------
  const refreshTree = useCallback(async (): Promise<void> => {
    if (!getStoredToken()) return;
    try {
      const r = await api.tree();
      setTree(r.items);
      setLoadErr(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearToken();
        setToken(null);
      } else {
        setLoadErr('无法加载文件树');
      }
    }
  }, []);

  useEffect(() => {
    if (token) void refreshTree();
  }, [token, refreshTree]);

  const scheduleTreeRefresh = useCallback((): void => {
    if (treeTimer.current !== undefined) window.clearTimeout(treeTimer.current);
    treeTimer.current = window.setTimeout(() => void refreshTree(), 300);
  }, [refreshTree]);

  // 等「确定落盘」：先等在途 PUT 完成，再补一发保存。用于同文件重入等必须串行的场景
  const flushSave = useCallback(async (): Promise<void> => {
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    for (let i = 0; i < 100 && savingRef.current; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (currentRef.current?.dirty) await doSaveRef.current();
  }, []);

  // ---------- 打开 / 应用文件 ----------
  const applyFile = useCallback((path: string, f: FileResp): void => {
    latestContentRef.current = f.content;
    setEditorValue(f.content);
    setPreviewSrc(f.content);
    setCur({ path, version: f.version, savedContent: f.content, mtime: f.mtime, dirty: false });
    setRemoteChange(null);
    setFileDeleted(false);
    setConflict(null);
    setSavePhase('idle');
  }, []);

  const applyRemoteFile = useCallback((f: FileResp): void => {
    latestContentRef.current = f.content;
    setEditorValue(f.content); // Editor 内部做最小 diff
    setPreviewSrc(f.content);
    mutateCur((x) => ({ ...x, version: f.version, mtime: f.mtime, savedContent: f.content, dirty: false }));
    setRemoteChange(null);
  }, []);

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      if (saveTimer.current !== undefined) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
      }
      // 有未保存改动一律先「确定落盘」再打开新文件：
      // - 同文件：等落盘后 GET 才不会带回旧内容回滚编辑器
      // - 跨文件：等落盘后快速切回旧文件时，GET 读到的必是已保存内容
      const prev = currentRef.current;
      if (prev && prev.dirty) {
        await flushSave();
        // 保存失败/冲突导致仍 dirty：保留现场（冲突框/错误状态引导用户决策），不重载
        if (currentRef.current?.dirty) return;
      }
      const seq = ++openSeq.current;
      try {
        const f = await api.getFile(path);
        if (seq !== openSeq.current) return;
        applyFile(path, f);
      } catch (e) {
        if (seq !== openSeq.current) return;
        setNotice(e instanceof ApiError && e.status === 404 ? '文件不存在' : '打开文件失败');
      }
    },
    [applyFile, flushSave],
  );

  // ---------- 保存 ----------
  const doSave = useCallback(async (opts?: { keepalive?: boolean }): Promise<void> => {
    const cur = currentRef.current;
    if (!cur) return;
    const content = latestContentRef.current;
    if (opts?.keepalive) {
      // 页面即将卸载：存在未确认内容（含在途、尚未被服务器确认的 PUT）就尽力补一发 keepalive 请求。
      // 若原 PUT 其实已落盘，这次会得到 409，无人处理、无副作用。
      const inflight = pendingPutRef.current;
      const inflightSame = !!inflight && inflight.path === cur.path && inflight.content === content;
      if (content === cur.savedContent && !inflightSame) return;
      api.putFile(cur.path, content, cur.version, true).catch(() => {});
      return;
    }
    if (content === cur.savedContent) return;
    // 客户端串行化：同一时刻最多一个 PUT；慢网络下连续输入合并为完成后的补存，
    // 避免两个 PUT 带着同一 baseVersion 竞争、必然 409 打断编辑
    if (savingRef.current) {
      resaveRef.current = true;
      return;
    }
    savingRef.current = true;
    const { path, version: baseVersion, savedContent: prevSaved } = cur;
    lastSaveRef.current = { path, content, at: Date.now() };
    pendingPutRef.current = { path, content };
    // 乐观标记已保存：让保存期间到达的自身回显能被识别
    mutateCur((x) => (x.path === path ? { ...x, savedContent: content, dirty: false } : x));
    setSavePhase('saving');
    let conflicted = false;
    try {
      const r = await api.putFile(path, content, baseVersion);
      const now = currentRef.current;
      if (now && now.path === path) {
        mutateCur((x) => ({
          ...x,
          version: r.version,
          mtime: r.mtime,
          dirty: latestContentRef.current !== content,
        }));
      }
      setSavePhase('saved');
      setSavedAt(new Date());
      if (path.startsWith('.timed/')) void refreshTimedRef.current();
    } catch (e) {
      mutateCur((x) => (x.path === path ? { ...x, savedContent: prevSaved, dirty: true } : x));
      if (e instanceof ApiError && e.status === 409) {
        conflicted = true;
        const body = (e.body ?? {}) as { currentVersion?: unknown; content?: unknown };
        setSavePhase('conflict');
        const cf: ConflictState = {
          path,
          remoteVersion: typeof body.currentVersion === 'string' ? body.currentVersion : null,
          remoteContent: typeof body.content === 'string' ? body.content : '',
          myContent: content,
        };
        if (currentRef.current?.path === path) {
          setConflict(cf);
        } else {
          setNotice(`原文件 ${path} 保存冲突，请重新打开处理`);
        }
      } else {
        setSavePhase('error');
      }
    } finally {
      savingRef.current = false;
      pendingPutRef.current = null;
      const shouldResave = resaveRef.current && !conflicted;
      resaveRef.current = false;
      if (shouldResave) {
        const c2 = currentRef.current;
        if (c2 && latestContentRef.current !== c2.savedContent) {
          if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(() => void doSaveRef.current(), 200);
        }
      }
    }
  }, []);

  doSaveRef.current = doSave;

  // ---------- 倒计时暂存库 ----------
  const refreshTimed = useCallback(async (): Promise<void> => {
    if (!getStoredToken()) return;
    try {
      const r = await api.timed();
      setTimedSlots(r.items);
      setTimedFetchedAt(Date.now());
    } catch {
      /* 服务不可达时保留旧数据，本地倒计时继续走 */
    }
  }, []);
  const refreshTimedRef = useRef(refreshTimed);
  refreshTimedRef.current = refreshTimed;

  // 定期校准倒计时（服务端 mtime 变化 = 任一端的编辑都会刷新剩余时间）
  useEffect(() => {
    if (!token) return;
    void refreshTimed();
    const t = window.setInterval(() => void refreshTimed(), 15000);
    return () => window.clearInterval(t);
  }, [token, refreshTimed]);

  // ---------- 复制 ----------
  async function copyAs(kind: 'source' | 'text'): Promise<void> {
    const cur = currentRef.current;
    if (!cur) return;
    const content = latestContentRef.current;
    const text = kind === 'source' ? content : markdownToPlainText(content);
    const ok = await copyText(text);
    setNotice(ok ? (kind === 'source' ? '已复制 Markdown 源码' : '已复制纯文本') : '复制失败（浏览器限制）');
  }

  // ---------- 导入本地文件 / 文件夹 ----------
  async function importFiles(files: File[], relOf: (f: File) => string): Promise<void> {
    if (files.length === 0) return;
    const curPath = currentRef.current?.path ?? '';
    const dir =
      curPath.includes('/') && !curPath.startsWith('.timed/')
        ? curPath.slice(0, curPath.lastIndexOf('/'))
        : '';
    let ok = 0;
    let skipped = 0;
    for (const f of files) {
      if (!/\.(md|markdown)$/i.test(f.name)) {
        skipped++;
        continue;
      }
      const relPath = relOf(f)
        .split('/')
        .map((s) => sanitizeName(s))
        .filter(Boolean)
        .join('/');
      if (!relPath) {
        skipped++;
        continue;
      }
      const target = dir ? `${dir}/${withMdSuffix(relPath)}` : withMdSuffix(relPath);
      try {
        const text = await f.text();
        try {
          await api.putFile(target, text, null);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            // 已存在同名文件：以导入内容为准覆盖
            const cur = await api.getFile(target);
            await api.putFile(target, text, cur.version);
          } else {
            throw e;
          }
        }
        ok++;
      } catch {
        skipped++;
      }
    }
    await refreshTree();
    await refreshTimedRef.current();
    setNotice(`导入完成：成功 ${ok} 个${skipped > 0 ? `，跳过 ${skipped} 个（仅支持 .md）` : ''}`);
  }

  // ---------- 冲突 / 黄条处理 ----------

  const onEditorChange = useCallback((content: string): void => {
    latestContentRef.current = content;
    setPreviewSrc(content);
    const c = currentRef.current;
    if (!c) return;
    if (content === c.savedContent) {
      if (c.dirty) mutateCur((x) => ({ ...x, dirty: false }));
      return;
    }
    if (!c.dirty) mutateCur((x) => ({ ...x, dirty: true }));
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void doSaveRef.current(), 800);
  }, []);

  const onSaveKey = useCallback((): void => {
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    void doSaveRef.current();
  }, []);

  // ---------- 远端事件 ----------
  const reconcileCurrent = useCallback(async (): Promise<void> => {
    const cur = currentRef.current;
    if (!cur) return;
    const seq = ++remoteSeq.current;
    let f: FileResp;
    try {
      f = await api.getFile(cur.path);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && currentRef.current?.path === cur.path) {
        setFileDeleted(true);
      }
      return;
    }
    if (seq !== remoteSeq.current) return;
    const now = currentRef.current;
    if (!now || now.path !== cur.path) return;
    if (f.version === now.version) return;
    const ls = lastSaveRef.current;
    if (ls && ls.path === now.path && f.content === ls.content) {
      // 自己写入的回显（可能先于 PUT 响应到达）：只对齐版本号，不动编辑器
      mutateCur((x) =>
        x.path === now.path
          ? {
              ...x,
              version: f.version,
              mtime: f.mtime,
              savedContent: f.content,
              dirty: latestContentRef.current !== f.content,
            }
          : x,
      );
      return;
    }
    if (!now.dirty) {
      applyRemoteFile(f);
    } else {
      setRemoteChange({ version: f.version, content: f.content });
    }
  }, [applyRemoteFile]);

  const onFileChanged = useCallback(
    (ev: { path: string; version: string; mtime: number }): void => {
      const cur = currentRef.current;
      if (!cur || ev.path !== cur.path) return; // 其它文件的变化由 tree-changed 处理
      void reconcileCurrent();
    },
    [reconcileCurrent],
  );

  const onFileRemoved = useCallback(
    (ev: { path: string }): void => {
      const cur = currentRef.current;
      if (cur && ev.path === cur.path) setFileDeleted(true);
      scheduleTreeRefresh();
    },
    [scheduleTreeRefresh],
  );

  const onSseOpen = useCallback((): void => {
    // 重连成功：立即重新对齐，防止断线期间漏事件
    scheduleTreeRefresh();
    void reconcileCurrent();
  }, [scheduleTreeRefresh, reconcileCurrent]);

  useEffect(() => {
    if (!token) return;
    const h = connectEvents(token, {
      onStatus: setConn,
      onOpen: onSseOpen,
      onFileChanged,
      onFileRemoved,
      onTreeChanged: scheduleTreeRefresh,
    });
    return () => h.close();
  }, [token, onSseOpen, onFileChanged, onFileRemoved, scheduleTreeRefresh]);

  // SSE 彻底断线时探测一次：若断线源于 token 失效，refreshTree 的 401 处理会引导重新配对
  useEffect(() => {
    if (conn === 'offline') void refreshTree();
  }, [conn, refreshTree]);

  // ---------- 切后台/关页立即 flush ----------
  useEffect(() => {
    const onVis = (): void => {
      if (document.hidden) {
        if (saveTimer.current !== undefined) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = undefined;
        }
        void doSaveRef.current();
      }
    };
    const onLeave = (): void => {
      if (saveTimer.current !== undefined) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
      }
      void doSaveRef.current({ keepalive: true });
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, []);

  // ---------- 冲突 / 黄条处理 ----------
  async function resolveConflict(mode: 'mine' | 'theirs', cfArg?: ConflictState): Promise<void> {
    const cf = cfArg ?? conflict;
    if (!cf) return;
    setSavePhase('saving');
    try {
      if (mode === 'mine') {
        const r = await api.putFile(cf.path, cf.myContent, cf.remoteVersion);
        const now = currentRef.current;
        if (now && now.path === cf.path) {
          latestContentRef.current = cf.myContent;
          setEditorValue(cf.myContent);
          setPreviewSrc(cf.myContent);
          mutateCur((x) => ({
            ...x,
            version: r.version,
            mtime: r.mtime,
            savedContent: cf.myContent,
            dirty: false,
          }));
        }
        setConflict(null);
        setRemoteChange(null);
        setSavePhase('saved');
        setSavedAt(new Date());
        if (cf.path.startsWith('.timed/')) void refreshTimedRef.current();
      } else {
        if (cf.remoteVersion === null) {
          setFileDeleted(true);
          setConflict(null);
        } else {
          applyRemoteFile({ content: cf.remoteContent, version: cf.remoteVersion, mtime: Date.now() });
          setConflict(null);
          setSavePhase('saved');
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = (e.body ?? {}) as { currentVersion?: unknown; content?: unknown };
        setConflict({
          path: cf.path,
          remoteVersion: typeof body.currentVersion === 'string' ? body.currentVersion : null,
          remoteContent: typeof body.content === 'string' ? body.content : '',
          myContent: cf.myContent,
        });
        setSavePhase('conflict');
        setNotice('远端又变化了，请重新选择');
      } else {
        setSavePhase('error');
        setNotice('操作失败');
      }
    }
  }

  function bannerReload(): void {
    const rc = remoteChange;
    if (!rc || rc.version === null) return;
    applyRemoteFile({ content: rc.content, version: rc.version, mtime: Date.now() });
    setSavePhase('idle');
  }

  async function bannerOverwrite(): Promise<void> {
    const rc = remoteChange;
    const cur = currentRef.current;
    if (!rc || !cur) return;
    const cf: ConflictState = {
      path: cur.path,
      remoteVersion: rc.version,
      remoteContent: rc.content,
      myContent: latestContentRef.current,
    };
    setRemoteChange(null);
    setConflict(cf);
    await resolveConflict('mine', cf);
  }

  async function restoreDeleted(): Promise<void> {
    const cur = currentRef.current;
    if (!cur) return;
    try {
      const r = await api.putFile(cur.path, latestContentRef.current, null);
      setFileDeleted(false);
      applyFile(cur.path, { content: latestContentRef.current, version: r.version, mtime: r.mtime });
    } catch (e) {
      setNotice(e instanceof ApiError && e.status === 409 ? '文件已被其它端重建' : '恢复失败');
    }
  }

  // ---------- 文件操作 ----------
  async function createFile(parent: string): Promise<void> {
    const raw = window.prompt('新文件名（不带 .md 后缀会自动添加）');
    if (raw === null) return;
    const sane = sanitizeName(raw);
    if (!sane) {
      setNotice('文件名不合法');
      return;
    }
    const name = withMdSuffix(sane);
    const path = parent ? `${parent}/${name}` : name;
    try {
      await api.putFile(path, '', null);
      await refreshTree();
      await openFile(path);
    } catch (e) {
      setNotice(e instanceof ApiError && e.status === 409 ? '文件已存在' : '创建失败');
    }
  }

  async function createDir(parent: string): Promise<void> {
    const raw = window.prompt('新文件夹名');
    if (raw === null) return;
    const name = sanitizeName(raw);
    if (!name) {
      setNotice('文件夹名不合法');
      return;
    }
    const path = parent ? `${parent}/${name}` : name;
    try {
      await api.mkdir(path);
      await refreshTree();
    } catch {
      setNotice('创建失败');
    }
  }

  async function renameNode(node: TreeNode): Promise<void> {
    if (node.type !== 'file') return;
    const raw = window.prompt('重命名为（不带 .md 后缀会自动添加）', node.name);
    if (raw === null) return;
    const sane = sanitizeName(raw);
    if (!sane) {
      setNotice('名称不合法');
      return;
    }
    const name = withMdSuffix(sane);
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    const to = parent ? `${parent}/${name}` : name;
    try {
      await api.rename(node.path, to);
      await refreshTree();
      if (currentRef.current?.path === node.path) await openFile(to);
    } catch (e) {
      setNotice(e instanceof ApiError && e.status === 409 ? '目标已存在' : '重命名失败');
    }
  }

  async function deleteNode(node: TreeNode): Promise<void> {
    if (node.type !== 'file') return;
    if (!window.confirm(`确定删除 ${node.name}？`)) return;
    try {
      await api.deleteFile(node.path);
      await refreshTree();
    } catch {
      setNotice('删除失败');
    }
  }

  // ---------- 渲染 ----------
  if (!token) {
    return (
      <Connect
        onPaired={(t, justSetup) => {
          storeToken(t);
          setToken(t);
          if (justSetup) setConnectInfo({ firstTime: true });
        }}
      />
    );
  }

  const q = search.trim().toLowerCase();
  // 「当前目录」：当前打开文件所在目录；未打开文件、或正在编辑暂存槽（.timed/）时为根。
  // 新建/上传都落在当前目录
  const currentDir =
    current && current.path.includes('/') && !current.path.startsWith('.timed/')
      ? current.path.slice(0, current.path.lastIndexOf('/'))
      : '';

  return (
    <div className="app">
      <aside className={`sidebar${drawerOpen ? ' open' : ''}`}>
        <div className="sidebar-head">
          <span className="brand">mdlive</span>
          <button className="icon-btn" onClick={() => setDrawerOpen(false)} aria-label="关闭侧栏">
            <Icon name="close" />
          </button>
        </div>
        <div className="toolbar">
          <input
            className="search"
            placeholder="搜索文件…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <nav className="tree">
          {loadErr ? <div className="tree-error">{loadErr}</div> : null}
          {tree === null && !loadErr ? <div className="tree-loading">加载中…</div> : null}
          {tree !== null ? (
            <FileTree
              items={filterTree(tree, q)}
              activePath={current?.path ?? null}
              onOpenFile={(p) => {
                void openFile(p);
                setDrawerOpen(false);
              }}
              onContext={(node, x, y) => setCtxMenu({ x, y, node })}
            />
          ) : null}
        </nav>
        <div className="sidebar-foot">
          <button onClick={() => setConnectInfo({ firstTime: false })}>
            <Icon name="link" size={15} /> 连接信息 / 配对码
          </button>
        </div>
      </aside>
      {drawerOpen ? <div className="backdrop" onClick={() => setDrawerOpen(false)} /> : null}

      <main className="main">
        <div className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setDrawerOpen(true)} aria-label="打开侧栏">
            <Icon name="menu" />
          </button>
          <span className="crumb">{current ? current.path : '未打开文件'}</span>
          <div className="topbar-actions">
            <button
              className="icon-btn"
              title="倒计时暂存库"
              onClick={() => {
                setShowTimed(true);
                void refreshTimedRef.current();
              }}
            >
              <Icon name="timer" />
              {timedSlots.some((s) => s.exists) ? <span className="badge-dot" /> : null}
            </button>
            <button
              className="icon-btn wide-only"
              title={currentDir ? `新建文件到 ${currentDir}/` : '新建文件到根目录'}
              onClick={() => void createFile(currentDir)}
            >
              <Icon name="file-plus" />
            </button>
            <button
              className="icon-btn wide-only"
              title={currentDir ? `新建文件夹到 ${currentDir}/` : '新建文件夹到根目录'}
              onClick={() => void createDir(currentDir)}
            >
              <Icon name="folder-plus" />
            </button>
            <button
              className="icon-btn wide-only"
              title="上传 .md 文件（当前目录）"
              onClick={() => importFileRef.current?.click()}
            >
              <Icon name="upload-file" />
            </button>
            <button
              className="icon-btn wide-only"
              title="导入本地文件夹（保留目录结构）"
              onClick={() => importFolderRef.current?.click()}
            >
              <Icon name="upload-folder" />
            </button>
            <button
              className="icon-btn wide-only"
              title="复制 Markdown 源码"
              disabled={!current}
              onClick={() => void copyAs('source')}
            >
              <Icon name="copy-code" />
            </button>
            <button
              className="icon-btn wide-only"
              title="复制纯文本（去掉 Markdown 语法）"
              disabled={!current}
              onClick={() => void copyAs('text')}
            >
              <Icon name="copy-text" />
            </button>
            <button
              className="icon-btn more-btn"
              title="更多操作"
              onClick={(e) =>
                setPlusMenu({ x: e.clientX, y: e.clientY })
              }
            >
              <Icon name="menu" />
            </button>
          </div>
          <div className="tabs narrow-only">
            <button className={pane === 'edit' ? 'active' : ''} onClick={() => setPane('edit')}>
              编辑
            </button>
            <button className={pane === 'preview' ? 'active' : ''} onClick={() => setPane('preview')}>
              预览
            </button>
          </div>
        </div>

        {remoteChange && current ? (
          <div className="banner warn">
            <span>远端已更新（本地有未保存改动）</span>
            <button onClick={() => void bannerOverwrite()}>用我的覆盖</button>
            <button onClick={bannerReload}>载入远端</button>
            <button className="icon-btn" onClick={() => setRemoteChange(null)} aria-label="忽略">
              ✕
            </button>
          </div>
        ) : null}
        {fileDeleted && current ? (
          <div className="banner warn">
            <span>文件已在其它端被删除</span>
            <button onClick={() => void restoreDeleted()}>恢复我的内容</button>
            <button onClick={() => { setCur(null); setFileDeleted(false); }}>关闭文件</button>
          </div>
        ) : null}

        <div className="content">
          {current ? (
            <>
              <div className={`pane editor-pane${pane === 'edit' ? '' : ' narrow-hidden'}`}>
                <Editor path={current.path} value={editorValue} onChange={onEditorChange} onSave={onSaveKey} />
              </div>
              <div className={`pane preview-pane${pane === 'preview' ? '' : ' narrow-hidden'}`}>
                <Preview source={previewSrc} />
              </div>
            </>
          ) : (
            <div className="empty">从左侧选择一个 Markdown 文件开始编辑</div>
          )}
        </div>

        <StatusBar
          conn={conn}
          savePhase={savePhase}
          savedAt={savedAt}
          version={current?.version ?? null}
          dirty={current?.dirty ?? false}
          path={current?.path ?? null}
        />
      </main>

      {ctxMenu ? (
        <>
          <div className="backdrop" style={{ zIndex: 65 }} onClick={() => setCtxMenu(null)} />
          <div
            className="ctx-menu"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 170),
              top: Math.min(ctxMenu.y, window.innerHeight - 220),
            }}
          >
            {ctxMenu.node.type === 'file' ? (
              <>
                <button onClick={() => { void openFile(ctxMenu.node.path); setCtxMenu(null); setDrawerOpen(false); }}>
                  打开
                </button>
                <button onClick={() => { void renameNode(ctxMenu.node); setCtxMenu(null); }}>重命名</button>
                <button className="danger" onClick={() => { void deleteNode(ctxMenu.node); setCtxMenu(null); }}>
                  删除
                </button>
              </>
            ) : (
              <>
                <button onClick={() => { void createFile(ctxMenu.node.path); setCtxMenu(null); }}>新建文件</button>
                <button onClick={() => { void createDir(ctxMenu.node.path); setCtxMenu(null); }}>新建文件夹</button>
              </>
            )}
          </div>
        </>
      ) : null}

      {conflict ? (
        <ConflictDialog
          conflict={conflict}
          onResolve={(m) => void resolveConflict(m)}
          onClose={() => {
            setConflict(null);
            setSavePhase('error');
          }}
        />
      ) : null}

      {plusMenu ? (
        <>
          <div className="backdrop" style={{ zIndex: 65 }} onClick={() => setPlusMenu(null)} />
          <div
            className="ctx-menu"
            style={{
              right: 8,
              top: Math.min(plusMenu.y + 8, window.innerHeight - 300),
              left: 'auto',
            }}
          >
            <button onClick={() => { void createFile(currentDir); setPlusMenu(null); }}>＋ 新建文件</button>
            <button onClick={() => { void createDir(currentDir); setPlusMenu(null); }}>＋ 新建文件夹</button>
            <button onClick={() => { setPlusMenu(null); importFileRef.current?.click(); }}>⬆ 上传 .md 文件</button>
            <button onClick={() => { setPlusMenu(null); importFolderRef.current?.click(); }}>⬆ 导入文件夹</button>
            <button disabled={!current} onClick={() => { void copyAs('source'); setPlusMenu(null); }}>
              复制 Markdown 源码
            </button>
            <button disabled={!current} onClick={() => { void copyAs('text'); setPlusMenu(null); }}>
              复制纯文本
            </button>
            <button onClick={() => { setPlusMenu(null); setShowTimed(true); void refreshTimedRef.current(); }}>
              倒计时暂存库
            </button>
          </div>
        </>
      ) : null}

      {connectInfo ? (
        <ConnectInfo token={token} firstTime={connectInfo.firstTime} onClose={() => setConnectInfo(null)} />
      ) : null}

      {showTimed ? (
        <TimedPanel
          slots={timedSlots}
          fetchedAt={timedFetchedAt}
          onClose={() => setShowTimed(false)}
          onOpen={(p) => {
            setShowTimed(false);
            void openFile(p);
          }}
          onClear={(p) => {
            void (async () => {
              try {
                await api.deleteFile(p);
                await refreshTimedRef.current();
              } catch {
                setNotice('清空失败');
              }
            })();
          }}
          onUpload={(slot, file) => {
            void (async () => {
              if (!/\.(md|markdown)$/i.test(file.name)) {
                setNotice('暂存库只支持 .md 文件');
                return;
              }
              try {
                const text = await file.text();
                try {
                  await api.putFile(slot.path, text, null);
                } catch (e) {
                  if (e instanceof ApiError && e.status === 409) {
                    const cur = await api.getFile(slot.path);
                    await api.putFile(slot.path, text, cur.version);
                  } else {
                    throw e;
                  }
                }
                await refreshTimedRef.current();
                setNotice(`已贴入「${file.name}」→ ${slot.label}，倒计时已重置`);
              } catch {
                setNotice('贴入失败');
              }
            })();
          }}
        />
      ) : null}

      <input
        ref={importFileRef}
        type="file"
        accept=".md,.markdown,text/markdown"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void importFiles([...e.target.files], (f) => f.name);
          e.target.value = '';
        }}
      />
      <input
        ref={(el) => {
          importFolderRef.current = el;
          if (el) {
            el.setAttribute('webkitdirectory', '');
            el.setAttribute('directory', '');
          }
        }}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) {
            void importFiles(
              [...e.target.files],
              (f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
            );
          }
          e.target.value = '';
        }}
      />

      {notice ? <div className="toast" onClick={() => setNotice(null)}>{notice}</div> : null}
    </div>
  );
}

function ConflictDialog({
  conflict,
  onResolve,
  onClose,
}: {
  conflict: ConflictState;
  onResolve: (m: 'mine' | 'theirs') => void;
  onClose: () => void;
}) {
  const s = diffSummary(conflict.myContent, conflict.remoteContent);
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>保存冲突</h3>
        <p>
          <code>{conflict.path}</code> 在远端已被修改，与你的本地改动冲突。
        </p>
        <div className="diff-summary">
          <div>你的改动：{s.mine}</div>
          <div>远端版本：{s.remote}</div>
          <pre className="diff-excerpt">{s.excerpt}</pre>
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={() => onResolve('mine')}>
            用我的覆盖
          </button>
          <button onClick={() => onResolve('theirs')}>放弃我的改动</button>
          <button className="link" onClick={onClose}>
            稍后处理
          </button>
        </div>
      </div>
    </div>
  );
}
