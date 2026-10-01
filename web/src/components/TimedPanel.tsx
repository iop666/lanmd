import { useEffect, useRef, useState } from 'react';
import type { TimedSlot } from '../api';
import Icon from './Icon';

interface Props {
  slots: TimedSlot[];
  fetchedAt: number;
  onOpen: (path: string) => void;
  onClear: (path: string) => void;
  onUpload: (slot: TimedSlot, file: File) => void;
  onClose: () => void;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function TimedPanel({ slots, fetchedAt, onOpen, onClear, onUpload, onClose }: Props) {
  const [, setTick] = useState(0);
  const fileInputs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const now = Date.now();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal timed-panel" onClick={(e) => e.stopPropagation()}>
        <h3>倒计时暂存库</h3>
        <p className="timed-hint">
          贴入内容或文件后开始倒计时，到期自动删除；任何一端再次编辑会刷新倒计时。正式笔记请勿放这里。
        </p>
        <div className="timed-grid">
          {slots.map((s) => {
            const remaining =
              s.exists && s.remainingMs !== null ? Math.max(0, s.remainingMs - (now - fetchedAt)) : null;
            const urgent = remaining !== null && remaining < 60_000;
            return (
              <div key={s.id} className={`timed-card${urgent ? ' urgent' : ''}`}>
                <div className="timed-label">{s.label}</div>
                <div className="timed-count">{remaining !== null ? fmt(remaining) : '空'}</div>
                <div className="timed-size">
                  {s.exists ? `${Math.ceil((s.size ?? 0) / 102.4) / 10} KB` : '—'}
                </div>
                <div className="timed-actions">
                  <button title="打开编辑" disabled={!s.exists} onClick={() => onOpen(s.path)}>
                    打开
                  </button>
                  <button
                    title="贴入本机文件"
                    onClick={() => fileInputs.current.get(s.id)?.click()}
                  >
                    贴入
                  </button>
                  <button title="立即清空" disabled={!s.exists} onClick={() => onClear(s.path)}>
                    清空
                  </button>
                  <input
                    ref={(el) => {
                      if (el) fileInputs.current.set(s.id, el);
                      else fileInputs.current.delete(s.id);
                    }}
                    type="file"
                    accept=".md,.markdown,text/markdown,text/plain"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onUpload(s, f);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="modal-actions">
          <span className="timed-note">
            <Icon name="timer" size={14} /> 到期自动删除，编辑即续时
          </span>
          <button className="primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
