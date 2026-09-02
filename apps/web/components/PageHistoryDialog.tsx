'use client';

import { useEffect, useState } from 'react';
import { X, History as HistoryIcon, Loader2, ChevronLeft } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { HistorySnapshot, PageBlock, PageContent } from '../lib/types';
import { BLOCK_TAG, BLOCK_CLASS } from '../lib/blockStyles';

/**
 * Snapshot timestamps are stored as `2026-08-13T10-30-00-000Z` — colons
 * and dots swapped for dashes, since a real ISO string isn't a valid
 * filename. This reverses just the time portion (after `T`) back into a
 * real ISO string `Date` can parse — the date portion's own hyphens are
 * untouched since the regex anchors specifically on the HH-MM-SS-mmm
 * pattern right before the trailing `Z`.
 */
function formatSnapshotTime(raw: string): string {
  const iso = raw.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Read-only rendering of a full block list — history preview, moderation
 * preview, and the public site page all just need "render these blocks
 * looking like the real document", not the interactive editing behavior
 * itself. Shares BLOCK_TAG/BLOCK_CLASS with the real editor (Editor.tsx)
 * so callout backgrounds, code block styling, heading sizes etc. can't
 * drift out of sync between the two the way they previously did (no
 * callout background color at all here, a plain "• "/"– " text prefix
 * for lists instead of a real hanging indent when a list item's text
 * wraps to a second line).
 */
export function BlockListPreview({ blocks }: { blocks: PageBlock[] }) {
  // Same per-consecutive-run numbering as Editor.tsx's own
  // numberedListIndices — not memoized here (no useMemo import pulled in
  // just for this), fine given a read-only preview's block count is
  // small and this only runs once per render anyway, same cost either way.
  const numberedListIndices = new Map<string, number>();
  let counter = 0;
  for (const b of blocks) {
    if (b.type === 'numberedList') {
      counter += 1;
      numberedListIndices.set(b.id, counter);
    } else {
      counter = 0;
    }
  }

  return (
    <>
      {blocks.map((block) => (
        <BlockPreview key={block.id} block={block} numberedListIndex={numberedListIndices.get(block.id)} />
      ))}
    </>
  );
}

function BlockPreview({ block, numberedListIndex }: { block: PageBlock; numberedListIndex?: number }) {
  if (block.type === 'divider') return <hr className="my-3 border-line/10" />;
  if (block.type === 'image') return <p className="mb-2 text-xs text-ink-faint">[Изображение{block.fileName ? `: ${block.fileName}` : ''}]</p>;
  if (block.type === 'file') return <p className="mb-2 text-xs text-ink-faint">[Файл{block.fileName ? `: ${block.fileName}` : ''}]</p>;

  const Tag = BLOCK_TAG[block.type] as keyof JSX.IntrinsicElements;
  const content = (
    <Tag
      className={clsx(
        BLOCK_CLASS[block.type],
        (block.type === 'bulletList' || block.type === 'numberedList') && 'list-none',
        block.type === 'todo' && block.checked && 'text-ink-faint line-through',
      )}
      dangerouslySetInnerHTML={{ __html: block.content }}
    />
  );

  // Bullet/numbered/todo get the same flex marker-plus-content layout as
  // the real editor — a proper hanging indent (the marker is its own
  // flex item, not text glued onto the front of the content), not a
  // plain "• " character prefix that leaves a wrapped second line
  // flush with the marker instead of aligned with the first line's text.
  if (block.type === 'bulletList' || block.type === 'numberedList' || block.type === 'todo') {
    return (
      <div className="mb-1 flex items-start gap-1">
        {block.type === 'todo' && (
          <input type="checkbox" checked={!!block.checked} disabled className="mt-2 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]" />
        )}
        {block.type === 'numberedList' && (
          <span className="mt-0.5 min-w-[1.5em] shrink-0 text-right text-[15px] leading-7 text-ink-muted">{numberedListIndex ?? 1}.</span>
        )}
        {block.type === 'bulletList' && <span className="mt-0.5 shrink-0 text-[15px] leading-7 text-ink-muted">•</span>}
        {content}
      </div>
    );
  }

  return <div className="mb-1">{content}</div>;
}

export function PageHistoryDialog({
  ownerId,
  projectId,
  pageId,
  canRestore,
  usersById,
  onClose,
  onRestored,
}: {
  ownerId: string;
  projectId: string;
  pageId: string;
  canRestore: boolean;
  usersById: Map<string, { displayName: string; avatarUrl: string | null }>;
  onClose: () => void;
  /** Called after a successful restore — the caller should reload the document's current content, since it just changed server-side. */
  onRestored: () => void;
}) {
  const [snapshots, setSnapshots] = useState<HistorySnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<HistorySnapshot | null>(null);
  const [previewContent, setPreviewContent] = useState<PageContent | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);

  useEffect(() => {
    api
      .listHistory(ownerId, projectId, pageId)
      .then(setSnapshots)
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить историю версий'));
  }, [ownerId, projectId, pageId]);

  const openSnapshot = (snap: HistorySnapshot) => {
    setSelected(snap);
    setPreviewContent(null);
    api
      .getHistorySnapshot(ownerId, projectId, pageId, snap.file)
      .then(setPreviewContent)
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить версию'));
  };

  const handleRestore = async () => {
    if (!selected) return;
    if (!confirm('Восстановить эту версию? Текущее содержимое станет прежним — но оно тоже не потеряется, само сохранится как ещё одна запись в истории.')) {
      return;
    }
    setIsRestoring(true);
    try {
      await api.restoreHistorySnapshot(ownerId, projectId, pageId, selected.file);
      onRestored();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось восстановить версию');
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-line/10 bg-surface-panel shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line/10 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {selected && (
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setPreviewContent(null);
                }}
                title="Назад к списку"
                className="rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-ink"
              >
                <ChevronLeft size={16} />
              </button>
            )}
            <HistoryIcon size={15} />
            {selected ? formatSnapshotTime(selected.timestamp) : 'История версий'}
          </h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

        {error && <p className="px-4 pt-3 text-sm text-red-500">{error}</p>}

        <div className="flex-1 overflow-y-auto p-4">
          {!selected ? (
            snapshots === null ? (
              <div className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 size={14} className="animate-spin" />
                Загрузка...
              </div>
            ) : snapshots.length === 0 ? (
              <p className="text-sm text-ink-faint">
                Пока нет сохранённых версий — они появляются автоматически при каждом сохранении содержимого.
              </p>
            ) : (
              <ul className="space-y-1">
                {snapshots.map((s) => (
                  <li key={s.file}>
                    <button
                      type="button"
                      onClick={() => openSnapshot(s)}
                      className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-hover"
                    >
                      <span className="text-ink">{formatSnapshotTime(s.timestamp)}</span>
                      <span className="text-xs text-ink-faint">{usersById.get(s.authorId)?.displayName ?? s.authorId}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : previewContent === null ? (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 size={14} className="animate-spin" />
              Загрузка версии...
            </div>
          ) : (
            <div className="mx-auto max-w-xl">
              <BlockListPreview blocks={previewContent.blocks} />
              {previewContent.blocks.length === 0 && <p className="text-sm text-ink-faint">Пустая страница.</p>}
            </div>
          )}
        </div>

        {selected && canRestore && (
          <div className="border-t border-line/10 p-4">
            <button
              type="button"
              onClick={() => void handleRestore()}
              disabled={isRestoring || previewContent === null}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-accent py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              {isRestoring && <Loader2 size={14} className="animate-spin" />}
              Восстановить эту версию
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
