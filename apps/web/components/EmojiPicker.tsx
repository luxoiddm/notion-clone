'use client';

import { useMemo, useState } from 'react';
import { Search, Clock } from 'lucide-react';
import clsx from 'clsx';
import { EMOJI_CATEGORIES, ALL_EMOJIS } from '../lib/emojiData';

const RECENT_KEY = 'chat:recent-emojis';
const RECENT_MAX = 24;

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(emoji: string) {
  try {
    const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* localStorage недоступен — просто без «недавних» */
  }
}

/** Панель эмодзи: поиск, недавние, категории. Вставка — через onPick. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState('');
  const [recent] = useState<string[]>(() => (typeof window === 'undefined' ? [] : readRecent()));
  const [active, setActive] = useState<string>(recent.length ? 'recent' : EMOJI_CATEGORIES[0]!.key);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return ALL_EMOJIS.filter((x) => x.k.includes(q)).map((x) => x.e);
  }, [query]);

  const list = results ?? (active === 'recent' ? recent : EMOJI_CATEGORIES.find((c) => c.key === active)?.emojis.map((x) => x.e) ?? []);

  const pick = (e: string) => {
    pushRecent(e);
    onPick(e);
  };

  return (
    <div className="flex w-[min(340px,calc(100vw-24px))] flex-col">
      <div className="relative p-2 pb-1.5">
        <Search size={13} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-faint" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти эмодзи" className="input h-8 pl-7 text-xs" autoFocus />
      </div>
      {!results && (
        <div className="flex gap-0.5 border-b border-line/[0.06] px-2 pb-1.5">
          {recent.length > 0 && (
            <button
              type="button"
              onClick={() => setActive('recent')}
              title="Недавние"
              className={clsx('flex h-7 w-7 items-center justify-center rounded-md', active === 'recent' ? 'bg-surface-hover text-ink' : 'text-ink-faint hover:bg-surface-hover')}
            >
              <Clock size={14} />
            </button>
          )}
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setActive(c.key)}
              title={c.label}
              className={clsx('flex h-7 w-7 items-center justify-center rounded-md text-base', active === c.key ? 'bg-surface-hover' : 'opacity-60 hover:bg-surface-hover hover:opacity-100')}
            >
              {c.icon}
            </button>
          ))}
        </div>
      )}
      <div className="grid h-56 grid-cols-8 content-start gap-0.5 overflow-y-auto p-2">
        {list.length === 0 ? (
          <p className="col-span-8 py-6 text-center text-xs text-ink-faint">Ничего не найдено</p>
        ) : (
          list.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => pick(e)}
              className="flex h-9 w-9 items-center justify-center rounded-md text-[22px] leading-none transition-transform hover:scale-110 hover:bg-surface-hover"
            >
              {e}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
