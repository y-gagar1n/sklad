// Генератор иконок приложения — рисует простой «ящик» на синем фоне.
// Без зависимостей: сами кодируем PNG (zlib + CRC). Запуск: node icons/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const ACCENT = [37, 99, 235]; // #2563eb
const WHITE = [255, 255, 255];

function makePNG(size) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };

  const S = size;
  const r = 0.14 * S; // скругление фона
  const inCorner = (x, y) => {
    const near = (cx, cy) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    if (x < r && y < r) return near(r, r);
    if (x > S - r && y < r) return near(S - r, r);
    if (x < r && y > S - r) return near(r, S - r);
    if (x > S - r && y > S - r) return near(S - r, S - r);
    return true;
  };

  // Фон.
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++)
      if (inCorner(x, y)) set(x, y, ACCENT);

  // Ящик: белый прямоугольник с синей «внутренностью» = контур.
  const bx0 = 0.24 * S, bx1 = 0.76 * S, by0 = 0.30 * S, by1 = 0.74 * S;
  const stroke = 0.06 * S;
  const rect = (x0, y0, x1, y1, col) => {
    for (let y = Math.floor(y0); y < y1; y++)
      for (let x = Math.floor(x0); x < x1; x++) set(x, y, col);
  };
  rect(bx0, by0, bx1, by1, WHITE);
  rect(bx0 + stroke, by0 + stroke, bx1 - stroke, by1 - stroke, ACCENT);

  // «Скотч»: горизонтальная линия-крышка и вертикальный шов сверху.
  const lidY = 0.45 * S;
  rect(bx0, lidY, bx1, lidY + stroke, WHITE);
  rect(0.5 * S - stroke / 2, by0, 0.5 * S + stroke / 2, lidY, WHITE);

  return encodePNG(px, size);
}

// ── Минимальный кодировщик PNG (truecolor+alpha) ──────────────────────────
function encodePNG(rgba, size) {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const idat = deflateSync(Buffer.from(raw));

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const here = new URL(".", import.meta.url).pathname;
for (const size of [192, 512, 180]) {
  const name = size === 180 ? "icon-180.png" : `icon-${size}.png`;
  writeFileSync(here + name, makePNG(size));
  console.log("written", name);
}
