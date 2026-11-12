import { useEffect, useState } from 'react';
import type { TaskItem, TaskStatus } from '../api';

interface Props {
  items: TaskItem[];
  deviceId: string;
  deviceName: string;
  /** 递增即切到「发送」视图（左下角添加按钮 / 更多菜单触发） */
  addSignal: number;
  onChangeName: (name: string) => void;
  onAdd: (title: string, note: string) => Promise<boolean>;
  onSetStatus: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
}

function rel(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  const dt = new Date(ms);
  const hm = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  if (dt.getFullYear() === new Date().getFullYear()) {
    return `${dt.getMonth() + 1}月${dt.getDate()}日 ${hm}`;
  }
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
}

/** 常驻在侧栏底部「连接信息 / 配对码」上方的任务区块（不悬浮、写死在布局里） */
export default function TaskFloat({
  items,
  deviceId,
  deviceName,
  addSignal,
  onChangeName,
  onAdd,
  onSetStatus,
  onDelete,
}: Props) {
  const [mode, setMode] = useState<'list' | 'add' | 'history'>('list');
  const [tab, setTab] = useState<'pending' | 'done'>('pending');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(deviceName);

  // 左下角添加入口只发信号，具体视图由本区块切换（添加功能位置不变）
  useEffect(() => {
    if (addSignal > 0) setMode('add');
  }, [addSignal]);

  const pending = items.filter((i) => i.status === 'pending');
  const done = items
    .filter((i) => i.status === 'done')
    .sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt));

  async function submit(): Promise<void> {
    if (!title.trim() || busy) return;
    setBusy(true);
    const ok = await onAdd(title.trim(), note.trim());
    setBusy(false);
    if (ok) {
      setTitle('');
      setNote('');
      setShowNote(false);
      setMode('list');
    }
  }

  function saveName(): void {
    const n = nameDraft.trim();
    if (n) onChangeName(n);
    else setNameDraft(deviceName);
    setEditingName(false);
  }

  function askDelete(id: string): void {
    if (window.confirm('删除这条任务？')) onDelete(id);
  }

  const who = (it: TaskItem, kind: 'created' | 'done'): string => {
    const id = kind === 'created' ? it.createdById : (it.doneById ?? '');
    const name = kind === 'created' ? it.createdBy : (it.doneBy ?? '对方');
    return id && id === deviceId ? '我' : name || '对方';
  };

  const renderCard = (it: TaskItem) => (
    <div key={it.id} className={`tf-card${it.status === 'done' ? ' is-done' : ''}`}>
      <div className="tf-card-title">{it.title}</div>
      {it.note ? <div className="tf-card-note">{it.note}</div> : null}
      <div className="tf-card-meta">
        {who(it, 'created')} 发起 · {rel(it.createdAt)}
        {it.status === 'done' && it.doneAt !== null ? (
          <span className="tf-card-ok"> · {who(it, 'done')} 已执行 {rel(it.doneAt)}</span>
        ) : null}
      </div>
      <div className="tf-card-bottom">
        <button className="tf-card-del" onClick={() => askDelete(it.id)}>
          删除
        </button>
        {it.status === 'pending' ? (
          <button className="primary" onClick={() => onSetStatus(it.id, 'done')}>
            已执行
          </button>
        ) : (
          <button onClick={() => onSetStatus(it.id, 'pending')}>撤销执行</button>
        )}
      </div>
    </div>
  );

  return (
    <div className="task-dock">
      <div className="tf-head">
        <div className="tf-title">
          {mode === 'list' ? (
            <>
              待确认 <span className="tf-count">{pending.length}</span>
            </>
          ) : mode === 'add' ? (
            '发给对方'
          ) : (
            '任务记录'
          )}
        </div>
        <div className="tf-tools">
          {mode === 'list' ? (
            <>
              <button title="添加" onClick={() => setMode('add')}>＋</button>
              <button title="历史 / 全部" onClick={() => { setMode('history'); setTab('done'); }}>☰</button>
            </>
          ) : (
            <button title="返回" onClick={() => setMode('list')}>‹</button>
          )}
        </div>
      </div>

      {mode === 'list' ? (
        <>
          <div className="tf-list">
            {pending.length === 0 ? (
              <div className="tf-empty">当前无任务</div>
            ) : (
              pending.map(renderCard)
            )}
          </div>
          <div className="tf-foot">
            {editingName ? (
              <input
                className="tf-name-input"
                autoFocus
                maxLength={16}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName();
                  if (e.key === 'Escape') {
                    setNameDraft(deviceName);
                    setEditingName(false);
                  }
                }}
              />
            ) : (
              <button
                className="tf-me"
                title="点击改名（对方看到的就是这个名字）"
                onClick={() => { setNameDraft(deviceName); setEditingName(true); }}
              >
                我：{deviceName} ✎
              </button>
            )}
          </div>
        </>
      ) : null}

      {mode === 'add' ? (
        <div className="tf-add">
          <textarea
            className="tf-input"
            rows={2}
            maxLength={200}
            placeholder="要对方做什么？"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {showNote ? (
            <input
              className="tf-input tf-note"
              maxLength={2000}
              placeholder="补充说明（可选）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          ) : (
            <button className="tf-note-toggle" onClick={() => setShowNote(true)}>＋ 加备注</button>
          )}
          <button className="primary tf-submit" disabled={!title.trim() || busy} onClick={() => void submit()}>
            {busy ? '发送中…' : '发送'}
          </button>
        </div>
      ) : null}

      {mode === 'history' ? (
        <>
          <div className="tf-tabs">
            <button className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>
              待执行 {pending.length}
            </button>
            <button className={tab === 'done' ? 'active' : ''} onClick={() => setTab('done')}>
              已完成 {done.length}
            </button>
          </div>
          <div className="tf-list">
            {(tab === 'pending' ? pending : done).length === 0 ? (
              <div className="tf-empty">当前无任务</div>
            ) : (
              (tab === 'pending' ? pending : done).map(renderCard)
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
