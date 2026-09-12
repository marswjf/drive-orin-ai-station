// 生成两张测试图，零依赖手写 PNG（Node 内置 zlib）
//  1) old-photo-832x464.png  —— 老照片修复的输入：非正方形、带划痕噪点泛黄
//  2) inpaint-768x1024.png   —— 局部重绘的输入：RGBA，中间一块 alpha=0 即待重绘区
// ⚠ 两张都**不是正方形**：方图会让所有比例 bug 隐身（skill 阶段 D 的必检项）
const zlib = require('zlib');
const fs = require('fs');

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// px: Buffer, 每像素 channels 字节
function writePNG(file, w, h, channels, px) {
  const colorType = channels === 4 ? 6 : 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                      // filter: None
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, out);
  return out.length;
}

const DIR = process.argv[2] || '.';

// ── 图 1：老照片（832×464，比例 1.793）────────────────────────────
{
  const W = 832, H = 464, C = 3;
  const px = Buffer.alloc(W * H * C);
  let seed = 20260901;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      // 底：泛黄的渐变天空 + 地平线 + 两个人形剪影，够辨认"内容有没有被改坏"
      const sky = 1 - y / H;
      let r = 150 + 70 * sky, g = 135 + 60 * sky, b = 100 + 35 * sky;
      if (y > H * 0.62) { r = 120 - 20 * sky; g = 108 - 18 * sky; b = 80 - 12 * sky; }   // 地面
      const d1 = Math.hypot(x - W * 0.36, (y - H * 0.52) * 1.7);
      const d2 = Math.hypot(x - W * 0.60, (y - H * 0.56) * 1.7);
      if (d1 < 46 || d2 < 40) { r *= 0.45; g *= 0.44; b *= 0.42; }                        // 人形
      // 老化：泛黄 + 颗粒噪点
      const n = (rnd() - 0.5) * 46;
      r += n + 16; g += n + 6; b += n - 12;
      px[i] = Math.max(0, Math.min(255, r));
      px[i + 1] = Math.max(0, Math.min(255, g));
      px[i + 2] = Math.max(0, Math.min(255, b));
    }
  }
  // 划痕：几道浅色斜线 + 一块霉斑
  const scratch = (x0, y0, x1, y1, wdt, val) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + (x1 - x0) * s / steps), y = Math.round(y0 + (y1 - y0) * s / steps);
      for (let dx = -wdt; dx <= wdt; dx++) for (let dy = -wdt; dy <= wdt; dy++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const i = (yy * W + xx) * C;
        px[i] = px[i + 1] = px[i + 2] = val;
      }
    }
  };
  scratch(90, 10, 250, H - 20, 1, 235);
  scratch(560, 0, 470, H - 1, 1, 240);
  scratch(700, 60, 830, 190, 0, 225);
  for (let y = 300; y < 380; y++) for (let x = 60; x < 150; x++) {
    const i = (y * W + x) * C;
    if (rnd() > 0.55) { px[i] = 90; px[i + 1] = 95; px[i + 2] = 70; }
  }
  const n = writePNG(DIR + '/old-photo-832x464.png', W, H, C, px);
  console.log('old-photo-832x464.png  ' + W + 'x' + H + '  比例 ' + (W / H).toFixed(3) + '  ' + n + ' 字节');
}

// ── 图 2：局部重绘输入（768×1024，比例 0.750，RGBA）──────────────
// alpha=0 的矩形就是待重绘区；ComfyUI 的 LoadImage 把 alpha 取反当 MASK
{
  const W = 768, H = 1024, C = 4;
  const px = Buffer.alloc(W * H * C);
  let seed = 777; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const MX0 = 232, MX1 = 536, MY0 = 300, MY1 = 620;    // 待重绘矩形
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      const t = y / H;
      let r = 96 + 120 * (1 - t), g = 120 + 100 * (1 - t), b = 168 + 70 * (1 - t);
      if (t > 0.72) { r = 80 + 30 * rnd(); g = 96 + 30 * rnd(); b = 74 + 24 * rnd(); }
      // 画几条竖向条纹，重绘后边界接不接得上一眼可见
      if (x % 96 < 6) { r *= 0.7; g *= 0.7; b *= 0.75; }
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
      px[i + 3] = (x >= MX0 && x < MX1 && y >= MY0 && y < MY1) ? 0 : 255;
    }
  }
  const n = writePNG(DIR + '/inpaint-768x1024.png', W, H, C, px);
  console.log('inpaint-768x1024.png   ' + W + 'x' + H + '  比例 ' + (W / H).toFixed(3) +
    '  待重绘区 ' + (MX1 - MX0) + 'x' + (MY1 - MY0) + '  ' + n + ' 字节');
}
