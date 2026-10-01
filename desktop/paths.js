'use strict';

/**
 * 便携路径解析 —— 本文件是整个外壳里最容易出错的部分，规则：
 * 1. 禁止用 process.cwd()：双击 exe 时 CWD 可能是 C:\Windows\System32
 * 2. 禁止用 process.execPath 推 exe 目录：portable 模式下它指向 %TEMP% 解压目录，每次启动都变
 * 3. portable 模式用 PORTABLE_EXECUTABLE_DIR（electron-builder 注入，指向真实 exe 所在目录）
 */
const path = require('node:path');
const fs = require('node:fs');

/** exe 真实所在目录（或 dev 模式下的项目根） */
function resolveBaseDir(app) {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return path.resolve(__dirname, '..');
}

/**
 * 数据目录：优先 <exe 目录>/Lanmd-data；写不进（只读位置）回退 %APPDATA%/Lanmd。
 * 返回 { dataDir, fallback, reason }，fallback=true 时由外壳用气泡告知用户。
 */
function resolveDataDir(app) {
  const base = resolveBaseDir(app);
  const preferred = path.join(base, 'Lanmd-data');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probe = path.join(preferred, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, String(Date.now()), 'utf8');
    fs.rmSync(probe, { force: true });
    return { dataDir: preferred, fallback: false, baseDir: base };
  } catch (e) {
    const fallbackDir = app.getPath('userData');
    fs.mkdirSync(fallbackDir, { recursive: true });
    return {
      dataDir: fallbackDir,
      fallback: true,
      baseDir: base,
      reason: `无法在程序目录创建数据文件夹（${e.code || e.message}），已改用系统应用数据目录`,
    };
  }
}

/** 打包后前端静态资源目录；dev 模式直接用仓库里的 web/dist */
function resolveWebDist(app) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web');
  }
  return path.resolve(__dirname, '..', 'web', 'dist');
}

/** 托盘图标目录 */
function resolveIconDir(app) {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.resolve(__dirname, 'build');
}

module.exports = { resolveBaseDir, resolveDataDir, resolveWebDist, resolveIconDir };
