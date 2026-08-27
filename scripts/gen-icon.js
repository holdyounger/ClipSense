/**
 * gen-icon.js - 生成托盘图标 PNG（无第三方依赖，纯 Node）
 *
 * 生成一个剪贴板形状的图标：
 * - 主体：圆角矩形（深色）
 * - 顶部：中间的小夹子/提手
 * - 配色：紫色系（呼应主界面 accent #6c5ce7）
 *
 * 用法：node scripts/gen-icon.js
 * 输出：src/renderer/tray-icon.png（16x16）、tray-icon@2x.png（32x32）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * 手写 PNG 编码器（生成 RGBA 像素的 PNG 文件）
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 像素缓冲（width*height*4）
 * @returns {Buffer} PNG 文件二进制
 */
function encodePNG(width, height, rgba) {
  // PNG 签名
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 6;   // color type: RGBA
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdr = chunk('IHDR', ihdrData);

  // IDAT：原始数据每行前加 filter byte (0)
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: None
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw));

  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// CRC32 实现
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 绘制剪贴板图标到 rgba 缓冲区
 * 简化形状：圆角矩形主体 + 顶部提手 + 几条内容线
 */
function drawClipboard(size) {
  const sc = size / 16; // 以 16 为基准缩放
  const rgba = Buffer.alloc(size * size * 4); // 全透明

  const accent = [108, 92, 231];   // #6c5ce7 主紫
  const accentDark = [72, 52, 212]; // #4834d4 深紫
  const white = [255, 255, 255];

  function setPx(x, y, color, alpha = 255) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (y * size + x) * 4;
    rgba[idx] = color[0];
    rgba[idx + 1] = color[1];
    rgba[idx + 2] = color[2];
    rgba[idx + 3] = alpha;
  }

  // 用简单的形状填充：主体矩形（圆角近似）
  // 坐标按 16 基准
  const body = { x0: 2, y0: 5, x1: 14, y1: 15 };
  const clip = { x0: 5, y0: 2, x1: 11, y1: 6 }; // 顶部提手

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ux = x / sc, uy = y / sc;

      // 顶部提手
      const inClip = ux >= clip.x0 && ux <= clip.x1 && uy >= clip.y0 && uy <= clip.y1;
      if (inClip) {
        setPx(x, y, accentDark, 255);
        continue;
      }

      // 主体（圆角近似，粗略忽略圆角）
      const inBody = ux >= body.x0 && ux <= body.x1 && uy >= body.y0 && uy <= body.y1;
      if (inBody) {
        // 边缘用深色描边，内部主体色
        const onEdge = ux === body.x0 || ux === body.x1 || uy === body.y0 || uy === body.y1;
        if (onEdge) {
          setPx(x, y, accentDark, 255);
        } else {
          setPx(x, y, accent, 255);
        }
        continue;
      }
    }
  }

  // 内容线（白色横线，示意剪贴板内容）
  const lines = [
    { y: 8, x0: 5, x1: 11 },
    { y: 10, x0: 5, x1: 12 },
    { y: 12, x0: 5, x1: 9 },
  ];
  for (const line of lines) {
    const yStart = Math.round(line.y * sc);
    for (let x = Math.round(line.x0 * sc); x <= Math.round(line.x1 * sc); x++) {
      if (x >= 0 && x < size && yStart >= 0 && yStart < size) {
        setPx(x, yStart, white, 230);
      }
    }
  }

  return rgba;
}

function main() {
  const outDir = path.join(__dirname, '..', 'src', 'renderer');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const sizes = [
    { name: 'tray-icon.png', size: 16 },
    { name: 'tray-icon@2x.png', size: 32 },
  ];

  for (const { name, size } of sizes) {
    const rgba = drawClipboard(size);
    const png = encodePNG(size, size, rgba);
    const outPath = path.join(outDir, name);
    fs.writeFileSync(outPath, png);
    console.log(`✅ 生成 ${outPath} (${size}x${size})`);
  }
}

main();
