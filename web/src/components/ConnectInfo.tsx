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

  useEffect(() => {
    api.connectInfo().then(setInfo).catch(() => setInfo({ urls: [], qr: null }));
  }, []);

  async function copyOne(text: string, tag: string): Promise<void> {
    const ok = await copyText(text);
    setCopied(ok ? tag : 'failed');
    window.setTimeout(() => setCopied(''), 1500);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal connect-info" onClick={(e) => e.stopPropagation()}>
        <h3>{firstTime ? '配对码已设置 ✓' : '连接其他设备'}</h3>
        <p>
          {firstTime
            ? '手机浏览器打开下面的地址（或扫码），即可连接本机笔记库。'
            : '在手机浏览器打开以下地址，输入配对码即可连接。'}
        </p>
        {info?.qr ? (
          <div className="qr-wrap">
            <img src={info.qr} alt="连接二维码（含配对码，扫码直接配对）" width={180} height={180} />
            <div className="qr-note">扫码直接配对，无需输入配对码</div>
          </div>
        ) : (
          <p className="connect-err">未找到局域网地址，请检查网络。</p>
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
