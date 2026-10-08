'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Link2, ArrowLeft, Search } from 'lucide-react';
import { api } from '../lib/api';
import type { PageBlock } from '../lib/types';
import type { AttachedPageRef } from './PagePickerDialog';

/**
 * A block is only a reasonable link target if it actually has visible
 * text — an empty paragraph, or an image/file/divider block, has
 * nothing a reader could confirm they landed on the right spot via, and
 * isn't the kind of thing "explained elsewhere" would ever point to. A
 * formula block *is* included — its raw LaTeX source is still
 * meaningful as a way to recognize which one it is in this list, even
 * though it isn't HTML like every other case here (see blockPreviewText
 * below).
 */
function isLinkableBlock(block: PageBlock): boolean {
  if (block.type === 'divider' || block.type === 'image' || block.type === 'file') return false;
  return blockPreviewText(block).trim().length > 0;
}

function blockPreviewText(block: PageBlock): string {
  if (block.type === 'formula') return block.content;
  const div = document.createElement('div');
  div.innerHTML = block.content;
  return div.textContent ?? '';
}

const HEADING_TYPES = new Set<PageBlock['type']>(['heading1', 'heading2', 'heading3']);

/**
 * Second step of the "link selected text to a document" flow (see its
 * own doc comment on `insertPageRefLink` in Editor.tsx for the full
 * picture) — shown after `PagePickerDialog` already picked *which*
 * page, this lets the user optionally narrow the link down to a
 * specific block within it, so the reader lands exactly where the term
 * is actually explained rather than at the top of a long document.
 * Skipping (the first, always-present option) keeps the link pointing
 * at the page as a whole, matching how "Ссылка на документ" already
 * behaved before this picker existed.
 */
export function PageBlockPickerDialog({
  page,
  onBack,
  onClose,
  onPick,
}: {
  page: AttachedPageRef;
  onBack: () => void;
  onClose: () => void;
  /** `null` means "just the page, no specific block". */
  onPick: (blockId: string | null) => void;
}) {
  const [blocks, setBlocks] = useState<PageBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setBlocks(null);
    setError(null);
    api
      .getPage(page.ownerId, page.projectId, page.pageId)
      .then(({ content }) => {
        if (!cancelled) setBlocks(content.blocks);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось загрузить содержимое страницы');
        setBlocks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [page.ownerId, page.projectId, page.pageId]);

  // Autofocuses the search box the moment the block list is actually
  // there to search through — pointless (and would just steal focus for
  // no reason) while still loading, so this waits for `blocks` rather
  // than firing once on mount.
  useEffect(() => {
    if (blocks !== null) searchInputRef.current?.focus();
  }, [blocks]);

  // Recomputed with `blocks` itself, not just derived inline on every
  // render — this list backs a keystroke-driven filter, and re-running
  // blockPreviewText's own DOM round-trip (div.innerHTML + textContent)
  // for every block on every keystroke is needless work when only
  // `query` actually changed.
  const linkable = useMemo(
    () => (blocks ?? []).filter(isLinkableBlock).map((block) => ({ block, text: blockPreviewText(block) })),
    [blocks],
  );

  const needle = query.trim().toLowerCase();
  const filtered = needle ? linkable.filter(({ text }) => text.toLowerCase().includes(needle)) : linkable;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog flex max-h-[70vh] w-full max-w-md flex-col p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-1.5">
          <button type="button" onClick={onBack} title="Назад к выбору документа" className="btn-icon h-7 w-7">
            <ArrowLeft size={16} />
          </button>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{page.title}</h2>
          <button type="button" onClick={onClose} className="btn-icon h-7 w-7">
            <X size={16} />
          </button>
        </div>
        <p className="mb-3 px-0.5 text-xs text-ink-faint">
          Выберите абзац или заголовок, куда должна вести ссылка — либо просто сошлитесь на документ целиком.
        </p>

        <button
          type="button"
          onClick={() => onPick(null)}
          className="mb-2 flex shrink-0 items-center gap-2 rounded-md border border-line/10 px-3 py-2 text-left text-sm text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          <Link2 size={14} className="shrink-0" />
          Просто ссылка на документ
        </button>

        {linkable.length > 0 && (
          <div className="relative mb-2 shrink-0">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter picks the match directly when the search has
                // narrowed it down to exactly one — the whole point of
                // adding search here was making this fast in a long
                // document, and typing a distinctive word then hitting
                // Enter is faster than reaching for the mouse. Left
                // alone (not auto-picking the first result) when there's
                // more than one match, since guessing wrong would link
                // to the wrong place with no visible warning.
                if (e.key !== 'Enter' || filtered.length !== 1 || !filtered[0]) return;
                e.preventDefault();
                onPick(filtered[0].block.id);
              }}
              placeholder="Поиск по тексту документа..."
              className="input pl-8"
            />
          </div>
        )}

        {error && <p className="mb-3 shrink-0 text-sm text-danger">{error}</p>}

        <div className="flex-1 space-y-0.5 overflow-y-auto border-t border-line/10 pt-2">
          {blocks === null ? (
            <p className="py-6 text-center text-sm text-ink-muted">Загрузка...</p>
          ) : linkable.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-faint">В этом документе пока нет текста.</p>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-faint">Ничего не найдено по «{query.trim()}».</p>
          ) : (
            filtered.map(({ block, text }) => (
              <button
                key={block.id}
                type="button"
                onClick={() => onPick(block.id)}
                className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-ink-muted hover:bg-surface-hover hover:text-ink ${
                  HEADING_TYPES.has(block.type) ? 'font-semibold text-ink' : ''
                }`}
              >
                {text}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
