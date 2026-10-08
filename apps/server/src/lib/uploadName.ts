/**
 * multer (busboy) по умолчанию разбирает имя файла из multipart как
 * latin1, поэтому «Отчёт.pdf» приходит как «ÐžÑ‚Ñ‡Ñ‘Ñ‚.pdf». Браузеры
 * шлют имя в UTF-8 — перекодируем обратно. Если строка не похожа на
 * испорченный UTF-8 (нет символов > 0x7F или после перекодирования
 * появляются «�»), возвращаем как есть.
 */
export function fixUploadName(name: string): string {
  if (!/[\u0080-ÿ]/.test(name) || /[Ā-￿]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}
