/**
 * Curated set of page icons — plain emoji, stored as-is in
 * PageMeta.icon (see FsEngine.updatePageIcon's doc comment: the backend
 * doesn't validate against this list, it's purely a frontend picker
 * convenience). Covers common article/page themes for a corporate
 * knowledge base — not an exhaustive emoji picker.
 */
export interface PageIconOption {
  emoji: string;
  label: string;
}

export const PAGE_ICON_OPTIONS: PageIconOption[] = [
  { emoji: '📄', label: 'Документ' },
  { emoji: '📝', label: 'Заметка' },
  { emoji: '📋', label: 'Регламент' },
  { emoji: '📌', label: 'Важное' },
  { emoji: '💡', label: 'Идея' },
  { emoji: '🎯', label: 'Цель' },
  { emoji: '📊', label: 'Отчёт' },
  { emoji: '📈', label: 'Аналитика' },
  { emoji: '🗂️', label: 'Архив' },
  { emoji: '⚙️', label: 'Настройка' },
  { emoji: '🔧', label: 'Инструмент' },
  { emoji: '🐞', label: 'Баг/проблема' },
  { emoji: '🚀', label: 'Запуск' },
  { emoji: '✅', label: 'Готово' },
  { emoji: '⚠️', label: 'Внимание' },
  { emoji: '❓', label: 'Вопрос' },
  { emoji: '👥', label: 'Команда' },
  { emoji: '📅', label: 'Событие' },
  { emoji: '💰', label: 'Финансы' },
  { emoji: '🔒', label: 'Конфиденциально' },
];

/**
 * PageMeta.icon holds either a plain emoji character or a tile-set image
 * URL (`/api/tile-sets/{set}/{index}`, served by tileSets.routes.ts on
 * the backend) — distinguished by this prefix, since an emoji character
 * never starts with a `/`. Every place that renders a page's icon needs
 * to tell these apart (plain text vs an `<img>`) — see PageIconDisplay,
 * the one shared component that does this check instead of every call
 * site repeating it.
 */
export function isTileIconUrl(icon: string): boolean {
  return icon.startsWith('/api/tile-sets/');
}
