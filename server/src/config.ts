import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  vault: string;
  port: number;
  /** 空字符串 = 未设置配对码（首次由浏览器设置）；也可被 MDLIVE_TOKEN 环境变量覆盖 */
  token: string;
  ignore: string[];
  /** 公网/隧道访问地址（如内网穿透域名），设置后连接信息与二维码优先使用 */
  publicUrl: string;
}

export interface LoadedConfig {
  cfg: Config;
  /** 把当前配置写回 config.json（保留用户手工加入的额外字段） */
  persist(): void;
  changedOnDisk(): boolean;
}

/** 项目根目录（server/src 与 server/dist 都在其下两层） */
export function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

type LogFn = (msg: string) => void;

export function loadConfig(log: LogFn): LoadedConfig {
  const root = projectRoot();
  // MDLIVE_DATA_DIR：覆盖 config.json / 默认 vault 的所在目录（图形外壳便携模式使用）
  const dataDir = process.env.MDLIVE_DATA_DIR ? path.resolve(process.env.MDLIVE_DATA_DIR) : root;
  const cfgPath = path.join(dataDir, 'config.json');
  const envVault = process.env.MDLIVE_VAULT;
  let cfgMtimeMs = 0;
  // 保留用户手工加入 config.json 的额外字段，回写时合并，不丢弃
  let extraKeys: Record<string, unknown> = {};

  const cfg: Config = {
    vault: path.resolve(dataDir, 'vault'),
    port: 8787,
    token: '',
    ignore: ['.git', '.obsidian', 'node_modules', '.trash'],
    publicUrl: '',
  };

  const readFromDisk = (): void => {
    cfgMtimeMs = 0;
    if (!fs.existsSync(cfgPath)) return;
    try {
      const stat = fs.statSync(cfgPath);
      cfgMtimeMs = stat.mtimeMs;
      // 容忍记事本等编辑器保存出的 UTF-8 BOM
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
      if (typeof raw.vault === 'string' && raw.vault !== '') cfg.vault = path.resolve(dataDir, raw.vault);
      if (typeof raw.port === 'number' && Number.isFinite(raw.port)) cfg.port = raw.port;
      if (typeof raw.token === 'string') cfg.token = raw.token;
      if (typeof raw.publicUrl === 'string') cfg.publicUrl = raw.publicUrl.replace(/\/+$/, '');
      if (Array.isArray(raw.ignore)) cfg.ignore = raw.ignore.filter((x): x is string => typeof x === 'string');
      extraKeys = raw;
    } catch (e) {
      log(`config.json 解析失败，使用默认配置: ${(e as Error).message}`);
    }
  };

  const persist = (): void => {
    if (envVault) return; // 无文件模式（MDLIVE_VAULT 设置时）不落盘
    fs.writeFileSync(cfgPath, JSON.stringify({ ...extraKeys, ...cfg }, null, 2) + '\n', 'utf8');
    try {
      cfgMtimeMs = fs.statSync(cfgPath).mtimeMs;
    } catch {
      /* ignore */
    }
  };

  if (!envVault) {
    // 设置了 MDLIVE_VAULT 时视为无文件模式：不读不写 config.json，避免污染真实配置
    readFromDisk();
    if (!fs.existsSync(cfgPath)) {
      // 首次启动：生成默认配置（token 留空，待浏览器端设置配对码）
      fs.mkdirSync(cfg.vault, { recursive: true });
      persist();
      log(`首次启动，已生成配置 ${cfgPath}`);
    }
  }

  if (envVault) cfg.vault = path.resolve(envVault);
  if (process.env.MDLIVE_PORT) {
    const p = Number.parseInt(process.env.MDLIVE_PORT, 10);
    if (Number.isFinite(p) && p > 0) cfg.port = p;
  }
  if (process.env.MDLIVE_TOKEN) cfg.token = process.env.MDLIVE_TOKEN;
  if (process.env.MDLIVE_PUBLIC_URL) cfg.publicUrl = process.env.MDLIVE_PUBLIC_URL.replace(/\/+$/, '');
  fs.mkdirSync(cfg.vault, { recursive: true });

  return {
    cfg,
    persist,
    changedOnDisk: () => {
      try {
        return fs.statSync(cfgPath).mtimeMs !== cfgMtimeMs;
      } catch {
        return false;
      }
    },
  };
}
