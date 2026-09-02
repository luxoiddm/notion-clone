'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  // Trigger button — kept separate from the dropdown itself now that the
  // dropdown is portaled out. Position is computed from this ref's screen
  // coordinates rather than relying on CSS position:absolute against the
  // parent, which is what let the cover banner's own `overflow-hidden`
  // (needed there for cropping the cover image) clip the bottom of this
  // dropdown when it was open above a cover — same root cause the cover
  // picker itself was fixed for in 1.33.3, same fix.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  // null until the first layout pass computes it — nothing renders before
  // then, avoiding a flash at the wrong (0,0) position.
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

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

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, left: rect.left });
    // Recomputed once per open, not on every scroll/resize — same
    // short-lived-popover reasoning as PageCoverPicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Portal content lives outside the trigger's own DOM subtree, so the
  // click-outside check needs to explicitly exclude the trigger button
  // too — a portal breaks the parent-child relationship a plain
  // ref.contains() on a shared wrapper used to rely on.
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current?.contains(e.target as Node)) return;
      if (buttonRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const activeSet = tileSets?.find((s) => s.name === activeTab) ?? null;

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
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

      {open && position && typeof document !== 'undefined' && createPortal(
        <div
          ref={pickerRef}
          style={{ position: 'fixed', top: position.top, left: position.left }}
          className="z-50 w-52 rounded-lg border border-line/10 bg-surface-panel p-2 shadow-panel">
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
        </div>,
        document.body,
      )}
    </div>
  );
}
