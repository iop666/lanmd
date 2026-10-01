'use strict';

/**
 * 托盘：唯一的 UI。左键 = 打开浏览器；右键 = 弹出菜单。
 * 注意：不要调用 tray.setContextMenu() —— 那会让左键也弹菜单；
 * 用 'click'（打开）+ 'right-click'（popUpContextMenu）分离。
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, Tray, Menu, nativeImage, shell, clipboard } = require('electron');

let tray = null;
let hooks = null; // 由 main.js 注入的回调集合
let iconDir = null; // 图标目录（extraResources 或 desktop/build）
let state = { status: 'starting', port: null, errorText: null, urls: [] };

function iconFor(status) {
  if (!hooks) return null;
  // 托盘用圆角透明 PNG（多尺寸 ico 的 nativeImage 解析不稳定，PNG 最可靠）。
  // 16（标准 DPI）/ 32（高 DPI）两档，启动时按主显示器 scaleFactor 选用
  let dpi = 16;
  try {
    const { screen } = require('electron');
    if (screen.getPrimaryDisplay().scaleFactor >= 1.5) dpi = 32;
  } catch {
    /* 取不到屏幕信息时用 16 */
  }
  const base = status === 'running' ? `icon-tray-${dpi}.png` : `icon-tray-warn-${dpi}.png`;
  const p = iconDir ? path.join(iconDir, base) : null;
  if (!p || !fs.existsSync(p)) {
    console.error(`[tray] 托盘 PNG 缺失: ${p ?? '(iconDir 未设置)'}，尝试 ico 兜底`);
    const fallback = hooks.iconPath;
    if (!fallback || !fs.existsSync(fallback)) {
      console.error('[tray] ico 兜底也不存在，托盘将无图标');
      return null;
    }
    const img = nativeImage.createFromPath(fallback);
    if (img.isEmpty()) {
      console.error('[tray] ico 兜底解析为空');
      return null;
    }
    const small = img.resize({ width: 16, height: 16 });
    return small.isEmpty() ? img : small;
  }
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) {
    console.error(`[tray] PNG 解析为空: ${p}`);
    return null;
  }
  return img;
}

function tooltip() {
  if (state.status === 'running') return `Lanmd · 联墨　运行中 :${state.port}`;
  if (state.status === 'error') return 'Lanmd · 联墨　服务异常';
  return 'Lanmd · 联墨　启动中…';
}

function autoLaunchInfo() {
  if (!app.isPackaged) {
    return { available: false, checked: false };
  }
  // portable 壳解压出的 exe 固定保留构建期文件名（Lanmd.exe），不跟随用户改名——
  // 因此 execPath 的 basename 在改名场景下不可用。改用数据目录（= exe 真实目录）里
  // 唯一的 .exe；多于一个或读取失败时退回构建期名（此时自启对改名 exe 不可用，诚实降级）
  const dir = process.env.PORTABLE_EXECUTABLE_DIR;
  let exeName = path.basename(process.execPath);
  if (dir) {
    try {
      const exes = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.exe'));
      if (exes.length === 1) exeName = exes[0];
    } catch {
      /* keep fallback */
    }
  }
  const exe = dir ? path.join(dir, exeName) : process.execPath;
  try {
    const s = app.getLoginItemSettings({ path: exe });
    return { available: true, checked: s.openAtLogin, exe };
  } catch {
    return { available: false, checked: false };
  }
}

function buildMenu() {
  const info = autoLaunchInfo();
  const statusText =
    state.status === 'running'
      ? `服务状态：运行中 :${state.port}`
      : state.status === 'error'
        ? `服务状态：异常${state.errorText ? ' — ' + state.errorText : ''}`
        : '服务状态：启动中…';

  const template = [
    {
      label: '打开 Lanmd',
      click: () => hooks.openApp(),
    },
    {
      label: '复制局域网地址',
      enabled: state.status === 'running' && state.urls.length > 0,
      click: () => {
        const target = hooks.shareUrl(state.urls[0]);
        clipboard.writeText(target);
        hooks.notify('已复制', target);
      },
    },
    { type: 'separator' },
    {
      label: '打开笔记库文件夹',
      click: () => hooks.openFolder('vault'),
    },
    {
      label: '打开数据文件夹',
      click: () => hooks.openFolder('data'),
    },
    {
      label: '查看日志',
      click: () => hooks.openFolder('logs'),
    },
    { type: 'separator' },
    { label: statusText, enabled: false },
    {
      label: state.status === 'error' ? '重试启动' : '重启服务',
      click: () => hooks.restartService(),
    },
    { type: 'separator' },
    info.available
      ? {
          label: '开机自启',
          type: 'checkbox',
          checked: info.checked,
          click: (item) => hooks.setAutoLaunch(item.checked, info.exe),
        }
      : { label: app.isPackaged ? '开机自启（当前环境不可用）' : '开机自启（开发模式不可用）', enabled: false },
    { type: 'separator' },
    {
      label: '退出',
      click: () => hooks.quit(),
    },
  ];
  return Menu.buildFromTemplate(template);
}

function refresh() {
  if (!tray) return;
  const img = iconFor(state.status);
  if (img) tray.setImage(img);
  tray.setToolTip(tooltip());
}

function create({ iconPath, iconDir: dir, hooks: h, initialStatus }) {
  hooks = h;
  iconDir = dir ?? null;
  state.status = initialStatus ?? 'starting';
  tray = new Tray(iconFor(state.status) ?? nativeImage.createEmpty());
  tray.setToolTip(tooltip());
  // 左键：打开；右键：菜单。双击不监听（会和 click 打架）
  tray.on('click', () => hooks.openApp());
  tray.on('right-click', () => {
    tray.popUpContextMenu(buildMenu());
  });
  return tray;
}

/** 状态机：starting / running / error */
function setStatus(status, { port, errorText, urls } = {}) {
  state = { status, port: port ?? state.port, errorText: errorText ?? null, urls: urls ?? state.urls };
  refresh();
}

function getState() {
  return state;
}

function destroy() {
  if (tray) tray.destroy();
  tray = null;
}

module.exports = { create, setStatus, buildMenu, getState, destroy };
