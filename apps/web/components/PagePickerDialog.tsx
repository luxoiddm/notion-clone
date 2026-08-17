'use client';

import { useEffect, useState } from 'react';
import { X, FileText } from 'lucide-react';
import { api } from '../lib/api';
import type { PageNode } from '../lib/types';
import { PageIconDisplay } from './PageIconDisplay';

export interface AttachedPageRef {
  ownerId: string;
  projectId: string;
  pageId: string;
  title: string;
}

function flattenPages(nodes: PageNode[]): PageNode[] {
  const result: PageNode[] = [];
  const walk = (list: PageNode[]) => {
    for (const n of list) {
      result.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return result;
}

export function PagePickerDialog({
  currentUserId,
  onClose,
  onPick,
}: {
  currentUserId: string;
  onClose: () => void;
  onPick: (page: AttachedPageRef) => void;
}) {
  const [ownPages, setOwnPages] = useState<PageNode[] | null>(null);
  const [sharedPages, setSharedPages] = useState<PageNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [projects, shared] = await Promise.all([api.listProjects(currentUserId), api.listShared()]);
        setSharedPages(shared);

        const project = projects[0];
        if (!project) {
          setOwnPages([]);
          return;
        }
        const tree = await api.listPages(currentUserId, project.id);
        setOwnPages(flattenPages(tree));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить страницы');
        setOwnPages([]);
        setSharedPages([]);
      }
    })();
  }, [currentUserId]);

  const isLoading = ownPages === null || sharedPages === null;
  const hasAny = (ownPages?.length ?? 0) + (sharedPages?.length ?? 0) > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="animate-popIn flex max-h-[70vh] w-full max-w-sm flex-col rounded-xl border border-line/10 bg-surface-panel p-5 shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Прикрепить страницу</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}

        <div className="flex-1 space-y-3 overflow-y-auto">
          {isLoading ? (
            <p className="py-6 text-center text-sm text-ink-muted">Загрузка...</p>
          ) : !hasAny ? (
            <p className="py-6 text-center text-sm text-ink-faint">Нет доступных страниц.</p>
          ) : (
            <>
              {ownPages && ownPages.length > 0 && (
                <div>
                  <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-ink-faint">Мои страницы</p>
                  {ownPages.map((page) => (
                    <PagePickerRow key={page.id} page={page} onPick={onPick} />
                  ))}
                </div>
              )}
              {sharedPages && sharedPages.length > 0 && (
                <div>
                  <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-ink-faint">Расшаренные со мной</p>
                  {sharedPages.map((page) => (
                    <PagePickerRow key={page.id} page={page} onPick={onPick} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PagePickerRow({ page, onPick }: { page: PageNode; onPick: (p: AttachedPageRef) => void }) {
  return (
    <button
      type="button"
      // page.ownerId, not the current viewer's id — matters for shared
      // pages, where they're not the same person. Was hardcoded to the
      // current user before shared pages existed here, which happened to
      // be harmless only because every page shown used to be their own.
      onClick={() => onPick({ ownerId: page.ownerId, projectId: page.projectId, pageId: page.id, title: page.title || 'Untitled' })}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-ink-muted hover:bg-surface-hover hover:text-ink"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line/10 bg-surface">
        <PageIconDisplay icon={page.icon} size={16} fallback={<FileText size={13} className="text-ink-faint" />} />
      </span>
      <span className="truncate">{page.title || 'Untitled'}</span>
    </button>
  );
}
