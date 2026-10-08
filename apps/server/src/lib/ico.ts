/**
 * Минимальный разбор .ico — чтобы из загруженного favicon.ico можно было
 * сделать PNG всех размеров (sharp сам формат ICO не читает).
 *
 * ICO — это контейнер из нескольких картинок. Каждая — либо готовый PNG
 * (так хранят большие размеры, 256×256), либо BMP без заголовка файла
 * (DIB: BITMAPINFOHEADER + пиксели снизу вверх + 1-битная маска
 * прозрачности). Берём самую большую картинку и возвращаем либо её PNG
 * как есть, либо «сырые» RGBA-пиксели, которые дальше отдаются в sharp.
 */

export type DecodedIco = { kind: 'png'; data: Buffer } | { kind: 'raw'; data: Buffer; width: number; height: number };

export function decodeIco(buf: Buffer): DecodedIco | null {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  if (count === 0 || buf.length < 6 + count * 16) return null;

  // Самая большая (а при равенстве — с большей глубиной цвета) картинка.
  let best: { w: number; bpp: number; size: number; offset: number } | null = null;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const w = buf[e] || 256;
    const bpp = buf.readUInt16LE(e + 6);
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    if (offset + size > buf.length) continue;
    if (!best || w > best.w || (w === best.w && bpp > best.bpp)) best = { w, bpp, size, offset };
  }
  if (!best) return null;

  const img = buf.subarray(best.offset, best.offset + best.size);
  // PNG внутри ICO — сигнатура \x89PNG.
  if (img.length >= 8 && img.readUInt32BE(0) === 0x89504e47) return { kind: 'png', data: Buffer.from(img) };
  return decodeDib(img);
}

function decodeDib(d: Buffer): DecodedIco | null {
  if (d.length < 40) return null;
  const headerSize = d.readUInt32LE(0);
  const width = d.readInt32LE(4);
  const height = Math.abs(d.readInt32LE(8)) / 2; // в ICO высота удвоена: цвет + маска
  const bpp = d.readUInt16LE(14);
  const compression = d.readUInt32LE(16);
  if (width <= 0 || height <= 0 || width > 1024 || height > 1024 || compression !== 0) return null;
  if (![1, 4, 8, 24, 32].includes(bpp)) return null;

  let pos = headerSize;
  const colors = d.readUInt32LE(32) || (bpp <= 8 ? 1 << bpp : 0);
  const palette: [number, number, number][] = [];
  for (let i = 0; i < colors && bpp <= 8; i++, pos += 4) palette.push([d[pos + 2]!, d[pos + 1]!, d[pos]!]);

  const rowBytes = Math.ceil((width * bpp) / 32) * 4;
  const maskRowBytes = Math.ceil(width / 32) * 4;
  const pixelsStart = pos;
  const maskStart = pixelsStart + rowBytes * height;
  const hasMask = d.length >= maskStart + maskRowBytes * height;
  const out = Buffer.alloc(width * height * 4);
  let anyAlpha = false;

  for (let y = 0; y < height; y++) {
    const row = pixelsStart + (height - 1 - y) * rowBytes; // DIB хранится снизу вверх
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r = 0,
        g = 0,
        b = 0,
        a = 255;
      if (bpp === 32) {
        b = d[row + x * 4]!;
        g = d[row + x * 4 + 1]!;
        r = d[row + x * 4 + 2]!;
        a = d[row + x * 4 + 3]!;
        if (a) anyAlpha = true;
      } else if (bpp === 24) {
        b = d[row + x * 3]!;
        g = d[row + x * 3 + 1]!;
        r = d[row + x * 3 + 2]!;
      } else {
        const bitPos = x * bpp;
        const byte = d[row + (bitPos >> 3)]!;
        const idx = (byte >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
        [r, g, b] = palette[idx] ?? [0, 0, 0];
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }

  // Прозрачность по 1-битной маске — для форматов без альфа-канала (или
  // 32-битных, где альфа целиком нулевая — старые иконки так делали).
  if (hasMask && (bpp !== 32 || !anyAlpha)) {
    for (let y = 0; y < height; y++) {
      const row = maskStart + (height - 1 - y) * maskRowBytes;
      for (let x = 0; x < width; x++) {
        const transparent = (d[row + (x >> 3)]! >> (7 - (x & 7))) & 1;
        out[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  }

  return { kind: 'raw', data: out, width, height };
}
