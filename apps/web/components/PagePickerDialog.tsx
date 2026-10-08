'use client';

import { useEffect, useRef, useState } from 'react';
import { X, FileText, Search } from 'lucide-react';
import { api } from '../lib/api';
import type { PageMeta, PageNode } from '../lib/types';
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

  // Global search — separate from the plain own/shared lists above,
  // queried server-side (FsEngine.searchVisiblePages) rather than
  // filtering `ownPages`/`sharedPages` client-side, since with many
  // documents the term being searched for might live in a document's
  // *content*, not just its title, and that content isn't loaded here
  // at all (only titles/icons are, for the plain list). Debounced by
  // hand (setTimeout + a cancellation flag) rather than firing a request
  // per keystroke — this is a real network round-trip that scans every
  // visible document's content server-side, not a free client-side
  // filter like the block-search in the next step of this same flow.
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PageMeta[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }
    let cancelled = false;
    setIsSearching(true);
    const timeout = setTimeout(() => {
      api
        .searchGlobal(trimmed)
        .then((results) => {
          if (!cancelled) setSearchResults(results);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Не удалось выполнить поиск');
          setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setIsSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query]);

  const isLoading = ownPages === null || sharedPages === null;
  const hasAny = (ownPages?.length ?? 0) + (sharedPages?.length ?? 0) > 0;
  const isSearchActive = query.trim().length > 0;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog flex max-h-[70vh] w-full max-w-sm flex-col p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Прикрепить страницу</h2>
          <button type="button" onClick={onClose} className="btn-icon h-7 w-7">
            <X size={16} />
          </button>
        </div>

        <div className="relative mb-3 shrink-0">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по всем документам (заголовок и текст)..."
            className="input pl-8"
          />
        </div>

        {error && <p className="mb-3 shrink-0 text-sm text-danger">{error}</p>}

        <div className="flex-1 space-y-3 overflow-y-auto">
          {isSearchActive ? (
            isSearching && searchResults === null ? (
              <p className="py-6 text-center text-sm text-ink-muted">Поиск...</p>
            ) : !searchResults || searchResults.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-faint">Ничего не найдено по «{query.trim()}».</p>
            ) : (
              <div>
                {searchResults.map((page) => (
                  <PagePickerRow key={`${page.ownerId}:${page.projectId}:${page.id}`} page={page} onPick={onPick} />
                ))}
              </div>
            )
          ) : isLoading ? (
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

function PagePickerRow({ page, onPick }: { page: PageMeta; onPick: (p: AttachedPageRef) => void }) {
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
