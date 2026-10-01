export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface SseHandlers {
  onStatus: (s: ConnState) => void;
  /** 连接建立或自动重连成功后触发，用于重新对齐 */
  onOpen: () => void;
  onFileChanged: (ev: { path: string; version: string; mtime: number }) => void;
  onFileRemoved: (ev: { path: string }) => void;
  onTreeChanged: () => void;
}

export function connectEvents(token: string, h: SseHandlers): { close: () => void } {
  let es: EventSource | null = null;
  let closed = false;
  let retry = 0;
  let timer: number | undefined;

  const open = (): void => {
    if (closed) return;
    h.onStatus(retry === 0 ? 'connecting' : 'reconnecting');
    es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.onopen = () => {
      retry = 0;
      h.onStatus('connected');
      h.onOpen();
    };
    es.addEventListener('file-changed', (e) => {
      try {
        h.onFileChanged(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('file-removed', (e) => {
      try {
        h.onFileRemoved(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('tree-changed', () => h.onTreeChanged());
    es.onerror = () => {
      if (es && es.readyState === EventSource.CLOSED) {
        // 浏览器放弃（如服务重启过快 / 401），手动退避重试
        h.onStatus(retry >= 3 ? 'offline' : 'reconnecting');
        retry++;
        timer = window.setTimeout(open, Math.min(1000 * retry, 5000));
      } else {
        // EventSource 自带重连中
        h.onStatus('reconnecting');
      }
    };
  };

  open();
  return {
    close: () => {
      closed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      es?.close();
    },
  };
}
