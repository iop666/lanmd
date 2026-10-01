import type { ConnState } from '../sse';

interface Props {
  conn: ConnState;
  savePhase: 'idle' | 'saving' | 'saved' | 'error' | 'conflict';
  savedAt: Date | null;
  version: string | null;
  dirty: boolean;
  path: string | null;
}

export default function StatusBar({ conn, savePhase, savedAt, version, dirty, path }: Props) {
  const connText =
    conn === 'connected'
      ? '已连接'
      : conn === 'connecting'
        ? '连接中…'
        : conn === 'reconnecting'
          ? '断线，重连中…'
          : '已断线';
  const saveText =
    savePhase === 'saving'
      ? '保存中…'
      : savePhase === 'saved'
        ? savedAt
          ? `已保存 ${savedAt.toTimeString().slice(0, 8)}`
          : '已保存'
        : savePhase === 'error'
          ? '保存失败'
          : savePhase === 'conflict'
            ? '冲突待处理'
            : dirty
              ? '未保存'
              : '';
  return (
    <div className="statusbar">
      <span className={`dot${conn === 'connected' ? ' ok' : conn === 'offline' ? ' bad' : ''}`} />
      <span>{connText}</span>
      <span>{saveText}</span>
      <span className="grow" />
      {path ? <span className="crumb-inline">{path}</span> : null}
      {version ? <span>v:{version}</span> : null}
    </div>
  );
}
