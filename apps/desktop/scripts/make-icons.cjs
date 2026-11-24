/**
 * 生成应用图标（第五轮）：npx electron scripts/make-icons.cjs build/icon-source.png
 *
 * 源图是黑色圆角方块（四周是不透明的黑色），这里按圆角方块裁出来放到透明背景上：
 * - build/icon.png：1024，macOS 图标网格（824 的圆角方块居中，带一点阴影），Linux 也用它
 * - build/icon.icns：iconutil 从 iconset 生成（macOS）
 * - build/icon.ico：16–256 多尺寸（Windows，圆角方块铺满）
 * - src/renderer/src/assets/logo.png：界面里用的小图标（侧栏标题、关于页）
 * - resources/icon.png：窗口图标（Windows / Linux 运行时、macOS 开发时的 Dock 图标）
 * 只用 Electron 自带的 Canvas，不需要额外的图片库。
 */
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.resolve(process.argv[2] || path.join(root, 'build', 'icon-source.png'));
// 源图里圆角方块的位置和圆角（用 probe 量出来的：左上角 54，边长 1143，圆角约 266）
const BOX = { x: 54, y: 54, size: 1143, radius: 266 };

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('about:blank');
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(src).toString('base64');
  /** 在页面里画：canvas 尺寸 size，圆角方块放在 inset 边距里，shadow 是否画阴影 */
  const render = (size, inset, shadow) =>
    w.webContents.executeJavaScript(`(async () => {
      const img = new Image(); img.src = ${JSON.stringify(dataUrl)}; await img.decode();
      const size = ${size}, inset = ${inset}, box = ${JSON.stringify(BOX)};
      const c = document.createElement('canvas'); c.width = c.height = size;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      const s = size - inset * 2;
      const r = box.radius * s / box.size;
      const path = () => { g.beginPath(); g.roundRect(inset + 0.5, inset + 0.5, s - 1, s - 1, r); };
      if (${shadow}) {
        g.save(); g.shadowColor = 'rgba(0,0,0,0.38)'; g.shadowBlur = size * 0.022; g.shadowOffsetY = size * 0.01;
        path(); g.fillStyle = '#000'; g.fill(); g.restore();
      }
      g.save(); path(); g.clip();
      g.drawImage(img, box.x, box.y, box.size, box.size, inset, inset, s, s);
      g.restore();
      return c.toDataURL('image/png').split(',')[1];
    })()`);
  const write = (file, b64) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log('写入', path.relative(root, file));
  };

  // macOS 网格：1024 画布里 824 的方块（四周各 100）
  const macPng = async (size) => render(size, Math.round(size * 100 / 1024), size >= 64);
  write(path.join(root, 'build', 'icon.png'), await macPng(1024));
  write(path.join(root, 'resources', 'icon.png'), await macPng(512));

  // icns
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'itm-iconset-')) + '/icon.iconset';
  fs.mkdirSync(set);
  for (const [name, px] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512], ['512x512@2x', 1024]]) {
    fs.writeFileSync(path.join(set, `icon_${name}.png`), Buffer.from(await macPng(px), 'base64'));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'build', 'icon.icns')]);
  console.log('写入 build/icon.icns');

  // ico：圆角方块铺满（Windows 不留 macOS 那么多边距），每个尺寸一张 PNG
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const px of sizes) pngs.push(Buffer.from(await render(px, Math.max(0, Math.round(px * 0.03)), false), 'base64'));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((px, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(px >= 256 ? 0 : px, e);
    header.writeUInt8(px >= 256 ? 0 : px, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([header, ...pngs]));
  console.log('写入 build/icon.ico');

  // 界面里的小图标（铺满，圆角方块）
  write(path.join(root, 'src', 'renderer', 'src', 'assets', 'logo.png'), await render(256, 0, false));
  app.quit();
});
