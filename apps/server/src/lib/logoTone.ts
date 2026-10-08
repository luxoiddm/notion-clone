import sharp from 'sharp';
import type { LogoTone } from '@core/fs-engine';

/**
 * «Тёмный» ли логотип — по средней яркости его непрозрачных пикселей.
 * Нужен, чтобы в тёмной теме автоматически инвертировать чёрные/тёмные
 * логотипы (иначе они сливаются с фоном), не трогая цветные и светлые.
 */
export async function detectLogoTone(image: Buffer): Promise<LogoTone> {
  const { data, info } = await sharp(image)
    .resize(96, 96, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const a = data[i + 3]! / 255;
    if (a < 0.2) continue;
    // Относительная яркость (sRGB, без линеаризации — для порога хватает).
    const l = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
    sum += l * a;
    weight += a;
  }
  if (weight === 0) return 'light';
  return sum / weight < 0.4 ? 'dark' : 'light';
}
