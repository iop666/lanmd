// 生成 desktop/build/icon.ico 与 icon-warn.ico（多尺寸 16/24/32/48/64/256）
// 源：icons/ 下的第一张 PNG。可重复执行：npm run icon（在 desktop 目录）
// ICO 容器为 PNG-in-ICO 格式（Vista+ 标准），无需第三方 ico 打包器
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const projectRoot = path.resolve(desktopRoot, '..');
const iconsDir = path.join(projectRoot, 'icons');
const outDir = path.join(desktopRoot, 'build');

const SIZES = [256, 64, 48, 32, 24, 16];

function findSourcePng() {
  const files = fs.readdirSync(iconsDir).filter((f) => f.toLowerCase().endsWith('.png'));
  if (files.length === 0) throw new Error(`icons/ 下没有 PNG 源文件: ${iconsDir}`);
  return path.join(iconsDir, files[0]);
}

/** 打包 PNG 数组为 ICO 容器（每项 {size, buf}） */
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + 16 * count;
  for (const { size, buf } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width（0 表示 256）
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // 调色板数
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.buf)]);
}

const redDotSvg = (size) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <circle cx="${size * 0.82}" cy="${size * 0.82}" r="${size * 0.16}" fill="#dc2626" stroke="#ffffff" stroke-width="${Math.max(2, Math.round(size * 0.04))}"/>
     </svg>`,
  );

/** 圆角遮罩：半径约 22%，四角透明。源 PNG 是白底方形，托盘小图需圆角+透明 */
const roundedMask = (size) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <rect x="0" y="0" width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" ry="${Math.round(size * 0.22)}"/>
     </svg>`,
  );

async function renderImages(source, overlaySvg, rounded) {
  const images = [];
  for (const size of SIZES) {
    let pipeline = sharp(source).resize(size, size, { fit: 'cover' });
    if (overlaySvg) {
      const base = await pipeline.png().toBuffer();
      pipeline = sharp(base).composite([{ input: overlaySvg(size) }]);
    }
    if (rounded) {
      const base = await pipeline.png().toBuffer();
      pipeline = sharp(base).composite([{ input: roundedMask(size), blend: 'dest-in' }]);
    }
    images.push({ size, buf: await pipeline.png().toBuffer() });
  }
  return images;
}

async function renderSingle(source, size, overlaySvg, rounded) {
  let pipeline = sharp(source).resize(size, size, { fit: 'cover' });
  if (overlaySvg) {
    const base = await pipeline.png().toBuffer();
    pipeline = sharp(base).composite([{ input: overlaySvg(size) }]);
  }
  if (rounded) {
    const base = await pipeline.png().toBuffer();
    pipeline = sharp(base).composite([{ input: roundedMask(size), blend: 'dest-in' }]);
  }
  return pipeline.png().toBuffer();
}

function writeFile(outPath, ico) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, ico);
  console.log(`written: ${outPath} (${ico.length} bytes)`);
}

const src = findSourcePng();
console.log(`source: ${src}`);
// exe/窗口资源图标：多尺寸 ico（同样圆角化，与托盘视觉统一）
writeFile(path.join(outDir, 'icon.ico'), buildIco(await renderImages(src, null, true)));
// 异常状态：叠加红点
writeFile(path.join(outDir, 'icon-warn.ico'), buildIco(await renderImages(src, redDotSvg, true)));
// 托盘专用：圆角 + 透明四角 PNG（Electron nativeImage 对多尺寸 ico 解析不稳定，PNG 最稳）
// 提供 16/32 两档，托盘按 DPI 自动选用
for (const size of [16, 32]) {
  fs.writeFileSync(
    path.join(outDir, `icon-tray-${size}.png`),
    await renderSingle(src, size, null, true),
  );
  fs.writeFileSync(
    path.join(outDir, `icon-tray-warn-${size}.png`),
    await renderSingle(src, size, redDotSvg, true),
  );
  console.log(`written: build/icon-tray-${size}.png / icon-tray-warn-${size}.png`);
}
