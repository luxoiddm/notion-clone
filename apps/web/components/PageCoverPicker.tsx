'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from 'next-themes';
import { ImagePlus, Palette, X, Loader2 } from 'lucide-react';
import { COVER_COLOR_PRESETS } from '../lib/coverColors';

export function PageCoverPicker({
  cover,
  onChange,
  uploadCoverImage,
  onClose,
  anchorRef,
}: {
  cover: string | null;
  onChange: (cover: string | null) => void;
  uploadCoverImage: (file: File) => Promise<string>;
  onClose: () => void;
  /**
   * The trigger button this picker positions itself relative to.
   * Rendered through a portal into document.body specifically so it
   * can't be clipped by the cover banner's own `overflow-hidden`
   * (needed there for cropping the cover image itself) — position is
   * computed from the trigger's own screen coordinates via
   * getBoundingClientRect() rather than relying on CSS
   * position:absolute against a clipped ancestor, which is what cut
   * off the bottom of this picker (the "Убрать обложку" button
   * specifically) when a tall palette pushed it past the banner's
   * own height.
   */
  anchorRef: React.RefObject<HTMLElement>;
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  // null until the first layout pass computes it — nothing renders
  // before then, avoiding a flash at the wrong (0,0) position.
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    // Recomputed once on mount only, not on every scroll/resize — this
    // picker is a short-lived popover (opens, one click, closes), not
    // something that needs to track the trigger's position live while
    // staying open through a page scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Portal content lives outside the trigger's own DOM subtree, so a
  // plain onClick-outside check against the picker alone would also
  // fire for the trigger button's own click that opened it in the
  // first place — excluded explicitly here, not just relying on event
  // bubbling order, since a portal breaks the usual parent-child
  // relationship stopPropagation would otherwise rely on.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current?.contains(e.target as Node)) return;
      if (anchorRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [anchorRef, onClose]);

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setIsUploading(true);
    setError(null);
    try {
      const url = await uploadCoverImage(file);
      onChange(url);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить изображение');
    } finally {
      setIsUploading(false);
    }
  };

  if (!position || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={pickerRef}
      style={{ position: 'fixed', top: position.top, right: position.right }}
      className="z-50 w-64 rounded-lg border border-line/10 bg-surface-panel p-3 shadow-panel"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          <Palette size={12} />
          Обложка
        </span>
        <button type="button" onClick={onClose} className="rounded p-0.5 text-ink-muted hover:bg-surface-hover hover:text-ink">
          <X size={14} />
        </button>
      </div>

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-line/10 px-2.5 py-1.5 text-xs text-ink-muted hover:bg-surface-hover disabled:opacity-60"
      >
        {isUploading ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
        {isUploading ? 'Загрузка...' : 'Загрузить изображение'}
      </button>
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelected} className="hidden" />

      {error && <p className="mb-2 text-xs text-red-500">{error}</p>}

      <div className="grid grid-cols-4 gap-1.5">
        {COVER_COLOR_PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            title={preset.label}
            onClick={() => {
              onChange(`color:${preset.key}`);
              onClose();
            }}
            className={`h-8 w-full rounded-md ${cover === `color:${preset.key}` ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface-panel' : ''}`}
            style={{ backgroundColor: isDark ? preset.dark : preset.light }}
          />
        ))}
      </div>

      {cover && (
        <button
          type="button"
          onClick={() => {
            onChange(null);
            onClose();
          }}
          className="mt-3 w-full rounded-md border-t border-line/10 pt-2 text-xs text-ink-faint hover:text-ink"
        >
          Убрать обложку
        </button>
      )}
    </div>,
    document.body,
  );
}
