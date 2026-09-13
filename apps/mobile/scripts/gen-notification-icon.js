/* global Buffer, __dirname */
// One-off placeholder generator for the Android notification icon
// (white monochrome 24x24 PNG, so the OS status bar can tint it).
// Run: node scripts/gen-notification-icon.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const W = 24;
const H = 24;

// Raw RGBA scanlines (filter byte 0 + RGBA per pixel).
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 4);
  raw[rowStart] = 0; // filter: None
  for (let x = 0; x < W; x++) {
    const o = rowStart + 1 + x * 4;
    // A filled rounded "bell" blob in the center, white (255,255,255,255).
    const cx = 12, cy = 12, r = 7;
    const dx = x - cx, dy = y - cy;
    const on = dx * dx + dy * dy <= r * r;
    // Add a small notch at bottom to suggest a bell clapper.
    const bell = on && !(y > 17 && Math.abs(x - 12) < 2);
    const v = bell ? 255 : 0;
    raw[o] = v; raw[o + 1] = v; raw[o + 2] = v; raw[o + 3] = bell ? 255 : 0;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const idat = zlib.deflateSync(raw);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'images', 'notification-icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
