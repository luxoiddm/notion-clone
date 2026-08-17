'use client';

import { useEffect, useRef, useState } from 'react';
import { PAGE_ICON_OPTIONS, isTileIconUrl } from '../lib/pageIcons';
import { api } from '../lib/api';

export function PageIconPicker({
  icon,
  onChange,
  readOnly = false,
  size = 56,
}: {
  icon: string | null;
  onChange: (icon: string | null) => void;
  readOnly?: boolean;
  /** Pixel size of the trigger button (square) — defaults to the original 56px used in the sidebar; a larger value (e.g. 128) is used for the icon shown next to the document title. Doesn't affect the picker dropdown's own thumbnail grid, which stays a fixed compact size regardless. */
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // "emoji" is always available; a tab per discovered tile set is added
  // once the list loads. Fetched lazily on first open, not on mount —
  // most page views never open this picker at all, no reason to hit the
  // backend for every single one. Each set's own tileIds — numeric
  // strings for a sprite-sheet set, real filenames for a folder-of-files
  // set — come straight from the backend; nothing here assumes a fixed
  // count or naming scheme.
  const [tileSets, setTileSets] = useState<{ name: string; tileIds: string[] }[] | null>(null);
  const [activeTab, setActiveTab] = useState('emoji');

  useEffect(() => {
    if (!open || tileSets !== null) return;
    api.listTileSets().then(setTileSets).catch(() => setTileSets([]));
  }, [open, tileSets]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const activeSet = tileSets?.find((s) => s.name === activeTab) ?? null;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => !readOnly && setOpen((v) => !v)}
        disabled={readOnly}
        title={readOnly ? undefined : 'Изменить ярлык страницы'}
        style={{ width: size, height: size, fontSize: size * 0.64 }}
        className={`flex items-center justify-center overflow-hidden rounded-lg leading-none ${readOnly ? '' : 'hover:bg-surface-hover'}`}
      >
        {icon && isTileIconUrl(icon) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={icon} alt="" style={{ width: size * 0.72, height: size * 0.72 }} className="rounded object-cover" />
        ) : (
          icon ?? '📄'
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-lg border border-line/10 bg-surface-panel p-2 shadow-panel">
          {tileSets && tileSets.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1 border-b border-line/10 pb-2">
              <button
                type="button"
                onClick={() => setActiveTab('emoji')}
                className={`rounded px-2 py-0.5 text-xs ${
                  activeTab === 'emoji' ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-hover'
                }`}
              >
                Эмодзи
              </button>
              {tileSets.map((set) => (
                <button
                  key={set.name}
                  type="button"
                  onClick={() => setActiveTab(set.name)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    activeTab === set.name ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-hover'
                  }`}
                >
                  {set.name}
                </button>
              ))}
            </div>
          )}

          {activeTab === 'emoji' ? (
            <div className="grid grid-cols-4 gap-1">
              {PAGE_ICON_OPTIONS.map((opt) => (
                <button
                  key={opt.emoji}
                  type="button"
                  title={opt.label}
                  onClick={() => {
                    onChange(opt.emoji);
                    setOpen(false);
                  }}
                  className={`flex h-10 w-10 items-center justify-center rounded-md text-xl hover:bg-surface-hover ${
                    icon === opt.emoji ? 'bg-accent-soft' : ''
                  }`}
                >
                  {opt.emoji}
                </button>
              ))}
            </div>
          ) : (
            <div className="grid max-h-52 grid-cols-4 gap-1 overflow-y-auto">
              {activeSet?.tileIds.map((tileId) => {
                const tileUrl = `/api/tile-sets/${activeTab}/${encodeURIComponent(tileId)}`;
                return (
                  <button
                    key={tileId}
                    type="button"
                    onClick={() => {
                      onChange(tileUrl);
                      setOpen(false);
                    }}
                    className={`flex h-10 w-10 items-center justify-center overflow-hidden rounded-md hover:bg-surface-hover ${
                      icon === tileUrl ? 'ring-2 ring-accent' : ''
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={tileUrl} alt="" className="h-full w-full object-cover" />
                  </button>
                );
              })}
            </div>
          )}

          {icon && (
            <button
              type="button"
              title="Сбросить на стандартный"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="mt-2 w-full rounded-md border-t border-line/10 pt-1.5 text-xs text-ink-faint hover:text-ink"
            >
              Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}
