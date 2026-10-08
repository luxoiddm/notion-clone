'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { gifsApi, type GifItem, type GifProvider } from '../lib/api';
import clsx from 'clsx';

type GifStatus = { enabled: boolean; provider: GifProvider | null; providers: GifProvider[] };
let statusCache: Promise<GifStatus> | null = null;

const PROVIDER_LABEL: Record<GifProvider, string> = { klipy: 'KLIPY', giphy: 'GIPHY' };
const TAB_KEY = 'chat:gif-provider';

/** Какие GIF-провайдеры настроены на сервере (KLIPY_API_KEY / GIPHY_API_KEY). Запрашивается один раз на вкладку браузера. */
export function useGifStatus() {
  const [status, setStatus] = useState<GifStatus>({ enabled: false, provider: null, providers: [] });
  useEffect(() => {
    statusCache ??= gifsApi
      .status()
      .then((s) => ({ ...s, providers: s.providers ?? (s.provider ? [s.provider] : []) }))
      .catch(() => ({ enabled: false, provider: null, providers: [] }));
    let alive = true;
    statusCache.then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

/**
 * Панель поиска GIF (как в Telegram): по умолчанию — популярные, при вводе —
 * поиск. Клик по GIF сразу отправляет его (onPick). Если на сервере
 * настроено несколько провайдеров — у каждого своя вкладка; последняя
 * выбранная запоминается в браузере.
 */
export function GifPicker({ providers, onPick }: { providers: GifProvider[]; onPick: (gif: GifItem) => void }) {
  const [provider, setProvider] = useState<GifProvider>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY) as GifProvider | null;
      if (saved && providers.includes(saved)) return saved;
    } catch {
      /* localStorage недоступен */
    }
    return providers[0] ?? 'klipy';
  });
  const switchProvider = (p: GifProvider) => {
    setProvider(p);
    try {
      localStorage.setItem(TAB_KEY, p);
    } catch {
      /* ignore */
    }
  };
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<GifItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const q = query.trim();
    const t = setTimeout(
      () => {
        (q ? gifsApi.search(provider, q) : gifsApi.trending(provider))
          .then((r) => {
            if (id !== reqId.current) return;
            setItems(r.items);
            setNext(r.next);
          })
          .catch((err) => id === reqId.current && setError(err instanceof Error ? err.message : 'Сервис GIF недоступен'))
          .finally(() => id === reqId.current && setLoading(false));
      },
      q ? 350 : 0,
    );
    return () => clearTimeout(t);
  }, [query, provider]);

  const loadMore = () => {
    if (!next) return;
    const id = reqId.current;
    setLoading(true);
    const q = query.trim();
    (q ? gifsApi.search(provider, q, Number(next)) : gifsApi.trending(provider, Number(next)))
      .then((r) => {
        if (id !== reqId.current) return;
        setItems((prev) => [...prev, ...r.items.filter((x) => !prev.some((p) => p.id === x.id))]);
        setNext(r.next);
      })
      .catch(() => undefined)
      .finally(() => id === reqId.current && setLoading(false));
  };

  // Две колонки «кирпичиками» — раскладываем по высоте, как в мессенджерах.
  const cols: GifItem[][] = [[], []];
  const heights = [0, 0];
  for (const g of items) {
    const i = heights[0]! <= heights[1]! ? 0 : 1;
    cols[i]!.push(g);
    heights[i]! += g.height / Math.max(1, g.width);
  }

  return (
    <div className="flex w-[min(360px,calc(100vw-24px))] flex-col">
      {providers.length > 1 && (
        <div className="px-2 pt-2">
          <div className="segmented flex w-full">
            {providers.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => switchProvider(p)}
                className={clsx('segmented-item flex-1', provider === p && 'segmented-item-active')}
              >
                {PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="relative p-2 pb-1.5">
        <Search size={13} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-faint" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск GIF" className="input h-8 pl-7 text-xs" autoFocus />
      </div>
      <div
        className="h-72 overflow-y-auto px-2 pb-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!loading && next && el.scrollTop + el.clientHeight > el.scrollHeight - 120) loadMore();
        }}
      >
        {error ? (
          <p className="py-10 text-center text-xs text-danger">{error}</p>
        ) : items.length === 0 && !loading ? (
          <p className="py-10 text-center text-xs text-ink-faint">Ничего не найдено</p>
        ) : (
          <div className="flex gap-1.5">
            {cols.map((col, ci) => (
              <div key={ci} className="flex flex-1 flex-col gap-1.5">
                {col.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => onPick(g)}
                    title={g.title}
                    className="overflow-hidden rounded-md bg-surface-sunken transition-opacity hover:opacity-85"
                    style={{ aspectRatio: `${g.width} / ${g.height}` }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.previewUrl} alt={g.title} loading="lazy" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {loading && (
          <div className="flex justify-center py-3 text-ink-faint">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
      </div>
      <div className="border-t border-line/[0.06] px-3 py-1.5 text-right text-[10px] font-medium uppercase tracking-wider text-ink-faint">
        Powered by {PROVIDER_LABEL[provider]}
      </div>
    </div>
  );
}
