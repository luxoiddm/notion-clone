'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Printer, FileText, FileType, History as HistoryIcon } from 'lucide-react';
import { PageIconPicker } from './PageIconPicker';
import { PageRefCard } from './PageRefCard';
import { TagEditor } from './TagEditor';
import { PageHistoryDialog } from './PageHistoryDialog';
import { extractPageRefs } from '../lib/pageRefs';
import { extractHeadings } from '../lib/tableOfContents';
import { documentToMarkdown, documentToPlainText, downloadTextFile, sanitizeFilename } from '../lib/exportDocument';
import type { PageBlock } from '../lib/types';

// Safe here (unlike inside the useMemo-computed extractors) because this
// only ever runs from a click handler — a genuine user interaction,
// where `document` is guaranteed to exist regardless of whether this
// route is ever server-rendered.
function scrollToBlock(blockId: string) {
  const el = document.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Same size/hover styling as PageIconPicker's own trigger button — "стилистика ярлыка" per the request, these sit right next to it and should read as one visual group, not a separately-styled toolbar bolted on. */
const ICON_BUTTON_CLASS = 'flex h-14 w-14 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-hover hover:text-ink';

function DownloadMenu({ title, blocks, onPrint }: { title: string; blocks: PageBlock[]; onPrint: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Exact same click-outside pattern as PageIconPicker — one convention
  // for every popover in this sidebar, not a bespoke one per component.
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={() => setOpen((v) => !v)} title="Скачать документ" className={ICON_BUTTON_CLASS}>
        <Download size={20} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-48 rounded-lg border border-line/10 bg-surface-panel p-1 shadow-panel">
          <button
            type="button"
            onClick={() => {
              downloadTextFile(`${sanitizeFilename(title)}.md`, documentToMarkdown(title, blocks), 'text/markdown');
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <FileText size={13} />
            Markdown (.md)
          </button>
          <button
            type="button"
            onClick={() => {
              downloadTextFile(`${sanitizeFilename(title)}.txt`, documentToPlainText(title, blocks), 'text/plain');
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <FileType size={13} />
            Текст (.txt)
          </button>
          <button
            type="button"
            onClick={() => {
              onPrint();
              setOpen(false);
            }}
            title="Откроется диалог печати браузера — выберите «Сохранить как PDF» в списке принтеров"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <Download size={13} />
            PDF (через печать)
          </button>
        </div>
      )}
    </div>
  );
}

export function DocumentSidebar({
  icon,
  onIconChange,
  tags,
  onTagsChange,
  blocks,
  title,
  ownerId,
  projectId,
  pageId,
  usersById,
  onRestored,
  readOnly,
  onClose,
}: {
  icon: string | null;
  onIconChange: (icon: string | null) => void;
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  blocks: PageBlock[];
  title: string;
  ownerId: string;
  projectId: string;
  pageId: string;
  usersById: Map<string, { displayName: string; avatarUrl: string | null }>;
  /** Called after a version is restored — the caller should reload the document's current content from the server. */
  onRestored: () => void;
  readOnly: boolean;
  /** Below `md` this renders as an overlay with a backdrop — onClose dismisses it (backdrop click). Above `md` it's a normal static panel and this is never called. */
  onClose: () => void;
}) {
  // Both driven entirely by scanning the content itself — not separate
  // state — so a heading/link appearing in the text and appearing here
  // can never drift out of sync with each other. Recomputes on every
  // content change, not just on load.
  const relatedPages = useMemo(() => extractPageRefs(blocks), [blocks]);
  const headings = useMemo(() => extractHeadings(blocks), [blocks]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Shared by the print button and the dropdown's "PDF (через печать)"
  // entry. The browser suggests `document.title` as the default filename
  // for "Save as PDF", and that's normally the *site* name
  // (SiteSettingsProvider sets it globally), not this document's own
  // title — swapped in only for the duration of the print dialog,
  // restored via `afterprint` rather than a timeout, since print dialogs
  // aren't reliably synchronous across browsers.
  const handlePrint = () => {
    const previousTitle = document.title;
    document.title = sanitizeFilename(title);
    const restore = () => {
      document.title = previousTitle;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
  };

  return (
    <>
      {/* Backdrop — mobile only; starts below the header (h-12), not
          inset-0, so the header's nav links stay clickable even while
          this is open — a full-viewport backdrop would otherwise catch
          clicks meant for the header first. On md and up the panel is
          static/in-flow, nothing to dim behind regardless. */}
      <div className="fixed inset-x-0 bottom-0 top-12 z-30 bg-black/30 md:hidden" onClick={onClose} />

      <aside className="fixed bottom-0 right-0 top-12 z-40 flex w-64 shrink-0 flex-col gap-6 overflow-y-auto border-l border-line/10 bg-surface-panel p-4 md:static md:inset-auto md:z-auto">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Ярлык и действия</h3>
          <div className="flex items-center gap-2">
            <PageIconPicker icon={icon} onChange={onIconChange} readOnly={readOnly} />
            <DownloadMenu title={title} blocks={blocks} onPrint={handlePrint} />
            <button type="button" onClick={handlePrint} title="Печать" className={ICON_BUTTON_CLASS}>
              <Printer size={20} />
            </button>
            <button type="button" onClick={() => setHistoryOpen(true)} title="История версий" className={ICON_BUTTON_CLASS}>
              <HistoryIcon size={20} />
            </button>
          </div>
        </section>

        {headings.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Разделы</h3>
            <nav className="space-y-0.5">
              {headings.map((h) => (
                <button
                  key={h.blockId}
                  type="button"
                  onClick={() => scrollToBlock(h.blockId)}
                  title={h.text}
                  style={{ paddingLeft: `${(h.level - 1) * 12}px` }}
                  className="block w-full truncate rounded px-1.5 py-1 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
                >
                  {h.text}
                </button>
              ))}
            </nav>
          </section>
        )}

        {relatedPages.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Связанные документы
            </h3>
            <div className="space-y-1.5">
              {relatedPages.map((ref) => (
                <PageRefCard key={`${ref.ownerId}:${ref.projectId}:${ref.pageId}`} ownerId={ref.ownerId} projectId={ref.projectId} pageId={ref.pageId} />
              ))}
            </div>
          </section>
        )}

        {(!readOnly || tags.length > 0) && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Теги</h3>
            <TagEditor tags={tags} onChange={onTagsChange} readOnly={readOnly} />
          </section>
        )}
      </aside>

      {historyOpen && (
        <PageHistoryDialog
          ownerId={ownerId}
          projectId={projectId}
          pageId={pageId}
          canRestore={!readOnly}
          usersById={usersById}
          onClose={() => setHistoryOpen(false)}
          onRestored={onRestored}
        />
      )}
    </>
  );
}
