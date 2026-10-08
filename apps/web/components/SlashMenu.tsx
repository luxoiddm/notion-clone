import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Code,
  MessageSquareQuote,
  Table,
  Minus,
  Pilcrow,
  Image as ImageIcon,
  Paperclip,
  Sigma,
  type LucideIcon,
} from 'lucide-react';
import type { PageBlockType } from '../lib/types';

export interface SlashOption {
  type: PageBlockType;
  label: string;
  icon: LucideIcon;
  keywords: string;
}

export const SLASH_OPTIONS: SlashOption[] = [
  { type: 'paragraph', label: 'Текст', icon: Pilcrow, keywords: 'text paragraph текст' },
  { type: 'heading1', label: 'Заголовок 1', icon: Heading1, keywords: 'h1 heading заголовок' },
  { type: 'heading2', label: 'Заголовок 2', icon: Heading2, keywords: 'h2 heading заголовок' },
  { type: 'heading3', label: 'Заголовок 3', icon: Heading3, keywords: 'h3 heading заголовок' },
  { type: 'bulletList', label: 'Маркированный список', icon: List, keywords: 'bullet list список' },
  { type: 'numberedList', label: 'Нумерованный список', icon: ListOrdered, keywords: 'numbered list нумерованный' },
  { type: 'todo', label: 'Чек-лист', icon: CheckSquare, keywords: 'todo check чек лист задача' },
  { type: 'code', label: 'Код', icon: Code, keywords: 'code код' },
  { type: 'callout', label: 'Callout', icon: MessageSquareQuote, keywords: 'callout note заметка' },
  { type: 'table', label: 'Таблица', icon: Table, keywords: 'table таблица' },
  { type: 'formula', label: 'Формула', icon: Sigma, keywords: 'formula latex katex math формула уравнение латех' },
  { type: 'image', label: 'Изображение', icon: ImageIcon, keywords: 'image photo картинка фото изображение' },
  { type: 'file', label: 'Файл', icon: Paperclip, keywords: 'file attachment файл вложение' },
  { type: 'divider', label: 'Разделитель', icon: Minus, keywords: 'divider line разделитель' },
];

/**
 * Single source of truth for "does this query match this option" — used
 * both by the menu's own rendering below and by Editor.tsx for keyboard
 * navigation bounds (Arrow keys) and Enter-to-confirm. Editor.tsx used to
 * hand-duplicate an approximation of this (a hardcoded English-only
 * keyword list) purely to compute a count for clamping the arrow-key
 * index — it could disagree with what was actually rendered here,
 * especially for Russian-language queries that only match via `label`,
 * not the `keywords` list. Import this instead of re-deriving it.
 */
export function filterSlashOptions(query: string): SlashOption[] {
  const q = query.toLowerCase();
  return SLASH_OPTIONS.filter((o) => o.keywords.includes(q) || o.label.toLowerCase().includes(q));
}

export function SlashMenu({
  query,
  activeIndex,
  onPick,
  position,
}: {
  query: string;
  activeIndex: number;
  onPick: (type: PageBlockType) => void;
  position: { top: number; left: number };
}) {
  const filtered = filterSlashOptions(query);

  if (filtered.length === 0) return null;

  return (
    <div
      className="popover fixed z-50 w-72 overflow-hidden p-0"
      style={{ top: position.top, left: position.left }}
    >
      <div className="max-h-72 overflow-y-auto p-1">
        {filtered.map((opt, i) => {
          const Icon = opt.icon;
          return (
            <button
              key={opt.type}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(opt.type);
              }}
              className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${
                i === activeIndex ? 'bg-surface-hover text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
              }`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line/[0.08] bg-surface-raised text-ink-muted shadow-xs">
                <Icon size={15} />
              </span>
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
