import { useEffect, useState } from 'react';
import { api } from '../api';

interface Props {
  onPaired: (token: string, justSetup: boolean) => void;
}

export default function Connect({ onPaired }: Props) {
  const [code, setCode] = useState('');
  const [code2, setCode2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [vault, setVault] = useState('');
  const [paired, setPaired] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setVault(h.vault);
        setPaired(h.paired);
      })
      .catch(() => setErr('无法连接服务'));
  }, []);

  async function tryPair(t: string): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.pair(t);
      onPaired(r.token, false);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setErr(status === 401 ? '配对码不正确' : '无法连接服务——请确认 Lanmd 正在运行（托盘有图标）');
    } finally {
      setBusy(false);
    }
  }

  async function doSetup(): Promise<void> {
    if (code !== code2) {
      setErr('两次输入不一致');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api.setupPin(code);
      onPaired(r.token, true);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403) setErr('配对码已被其它设备设置，请输入已有配对码');
      else setErr('设置失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // 支持扫码直达：?token=xxx
    const t = new URLSearchParams(window.location.search).get('token');
    if (t) {
      window.history.replaceState({}, '', window.location.pathname);
      void tryPair(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setupMode = paired === false;

  return (
    <div className="connect">
      <div className="connect-card">
        <h1>mdlive</h1>
        <p>{vault ? `Vault：${vault}` : '局域网 Markdown 编辑器'}</p>
        {setupMode ? (
          <>
            <p className="connect-hint">
              首次使用：设置一个配对码，之后所有设备（手机/电脑）都用它连接。
            </p>
            <input
              type="text"
              autoComplete="off"
              placeholder="设置配对码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <input
              type="text"
              autoComplete="off"
              placeholder="再输入一次确认"
              value={code2}
              onChange={(e) => setCode2(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code && code2 && !busy) void doSetup();
              }}
            />
            <button className="primary" disabled={!code || !code2 || busy} onClick={() => void doSetup()}>
              {busy ? '设置中…' : '设置并进入'}
            </button>
          </>
        ) : (
          <>
            <input
              type="text"
              autoComplete="off"
              placeholder="输入配对码"
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code && !busy) void tryPair(code);
              }}
            />
            <button className="primary" disabled={!code || busy} onClick={() => void tryPair(code)}>
              {busy ? '连接中…' : '连接'}
            </button>
          </>
        )}
        {err ? <p className="connect-err">{err}</p> : null}
      </div>
    </div>
  );
}
