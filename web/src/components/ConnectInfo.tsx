import { useEffect, useState } from 'react';
import { api, type ConnectInfo } from '../api';
import { copyText } from '../copy';
import Icon from './Icon';

interface Props {
  token: string;
  onClose: () => void;
  /** 配对码刚设置完成时展示更醒目的引导 */
  firstTime?: boolean;
}

export default function ConnectInfo({ token, onClose, firstTime }: Props) {
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [copied, setCopied] = useState('');
  const [tunnelInput, setTunnelInput] = useState<string | null>(null); // null = 未展开编辑
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelMsg, setTunnelMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api
      .connectInfo()
      .then((ci) => {
        setInfo(ci);
        setTunnelInput(null);
      })
      .catch(() => setInfo({ urls: [], qr: null, publicUrl: '' }));
  }, []);

  async function reloadInfo(): Promise<void> {
    try {
      const ci = await api.connectInfo();
      setInfo(ci);
    } catch {
      /* 保留旧数据 */
    }
  }

  async function saveTunnel(url: string): Promise<void> {
    setTunnelBusy(true);
    setTunnelMsg(null);
    try {
      const r = await api.setPublicUrl(url);
      setTunnelInput(null);
      setTunnelMsg({
        ok: true,
        text: r.publicUrl === '' ? '已清除隧道地址，二维码恢复为局域网地址' : '隧道地址已保存，二维码已更新',
      });
      await reloadInfo();
    } catch (e) {
      const status = (e as { status?: number }).status;
      setTunnelMsg({
        ok: false,
        text: status === 400 ? '地址格式不正确（需以 http:// 或 https:// 开头）' : '保存失败，请重试',
      });
    } finally {
      setTunnelBusy(false);
    }
  }

  async function copyOne(text: string, tag: string): Promise<void> {
    const ok = await copyText(text);
    setCopied(ok ? tag : 'failed');
    window.setTimeout(() => setCopied(''), 1500);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal connect-info" onClick={(e) => e.stopPropagation()}>
        <h3>{firstTime ? '配对码已设置 ✓' : '连接信息'}</h3>
        <p>
          {firstTime
            ? '手机浏览器打开下面的地址（或扫码），即可连接本机笔记库。'
            : '手机/其他设备打开以下地址，输入配对码即可连接。'}
        </p>

        {info?.qr ? (
          <div className="qr-wrap">
            <img src={info.qr} alt="连接二维码（含配对码，扫码直接配对）" width={180} height={180} />
            <div className="qr-note">
              {info.publicUrl !== '' ? '二维码为隧道地址，异网设备可直接扫码' : '扫码直接配对，无需输入配对码'}
            </div>
          </div>
        ) : (
          <p className="connect-err">未找到可用地址，请检查网络或配置隧道。</p>
        )}

        <div className="url-list">
          {info?.urls.map((u) => (
            <div key={u} className="url-row">
              <code>{u}/?token={token}</code>
              <button
                className="icon-btn"
                title="复制地址"
                onClick={() => void copyOne(`${u}/?token=${token}`, u)}
              >
                {copied === u ? '✓' : <Icon name="copy-code" size={16} />}
              </button>
            </div>
          ))}
        </div>

        <div className="tunnel-section">
          <div className="tunnel-head">
            <span>隧道穿透（异网访问）</span>
            {tunnelInput === null ? (
              <button
                className="link"
                onClick={() => {
                  setTunnelMsg(null);
                  setTunnelInput(info?.publicUrl ?? '');
                }}
              >
                设置…
              </button>
            ) : null}
          </div>
          {info?.publicUrl !== '' && tunnelInput === null ? (
            <p className="tunnel-current">
              当前隧道地址：<code>{info?.publicUrl}</code>
            </p>
          ) : null}
          {tunnelInput !== null ? (
            <div className="tunnel-edit">
              <input
                type="text"
                autoComplete="off"
                placeholder="https://xxx.natfrp.cloud（留空清除）"
                value={tunnelInput}
                onChange={(e) => setTunnelInput(e.target.value)}
              />
              <div className="tunnel-actions">
                <button disabled={tunnelBusy} onClick={() => void saveTunnel(tunnelInput.trim())}>
                  {tunnelBusy ? '保存中…' : '保存'}
                </button>
                <button
                  disabled={tunnelBusy}
                  onClick={() => {
                    setTunnelInput(null);
                    setTunnelMsg(null);
                  }}
                >
                  取消
                </button>
                {info?.publicUrl !== '' ? (
                  <button
                    className="danger"
                    disabled={tunnelBusy}
                    onClick={() => void saveTunnel('')}
                  >
                    清除
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {tunnelMsg ? (
            <p className={tunnelMsg.ok ? 'tunnel-ok' : 'connect-err'}>{tunnelMsg.text}</p>
          ) : null}
          <p className="tunnel-hint">
            使用 natfrp / frp 等工具把本机端口（8787）映射到公网，把得到的地址填到这里，
            手机在任何网络都能扫码连接。配对码是唯一防线，公网环境请使用长且随机的口令。
          </p>
        </div>

        <div className="modal-actions">
          <button onClick={() => void copyOne(token, 'pin')}>
            {copied === 'pin' ? '已复制 ✓' : '复制配对码'}
          </button>
          <button className="primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
