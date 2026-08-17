'use client';

import { useMemo, useState } from 'react';
import { ChevronRight, FileText, Plus, Search, Users, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { PageNode } from '../lib/types';
import { SidebarSkeleton } from './Skeleton';
import { PageIconDisplay } from './PageIconDisplay';
import { useSiteSettings, logoUrlWithCacheBust, HEADER_LOGO_HEIGHT } from './SiteSettingsProvider';

export interface SharedPageItem extends PageNode {
  ownerName: string;
}

interface SidebarProps {
  pages: PageNode[];
  isLoading: boolean;
  activePageId: string | null;
  onSelect: (pageId: string) => void;
  onCreatePage: (parentId: string | null) => void;
  onMovePage: (pageId: string, newParentId: string | null, newOrder: number) => void;
  onDeletePage: (pageId: string) => void;
  onSearch: (query: string) => void;
  searchResults: { id: string; title: string }[] | null;
  sharedPages?: SharedPageItem[];
  onSelectShared?: (page: SharedPageItem) => void;
  /** Below the `md` breakpoint this becomes an off-canvas drawer instead of always-visible — see the className below. Above `md` these two are irrelevant (CSS forces it visible regardless), so callers on desktop-only surfaces can just pass `mobileOpen={false}`. */
  mobileOpen: boolean;
  onMobileClose: () => void;
}

const VIRTUALIZE_THRESHOLD = 100;

export function Sidebar({
  pages,
  isLoading,
  activePageId,
  onSelect,
  onCreatePage,
  onMovePage,
  onDeletePage,
  onSearch,
  searchResults,
  sharedPages = [],
  onSelectShared,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const flatCount = useMemo(() => countNodes(pages), [pages]);
  const { settings } = useSiteSettings();
  const logoSrc = logoUrlWithCacheBust(settings, 'header');

  // Closing the drawer after picking something is a no-op on desktop
  // (the drawer's visibility there is forced by CSS regardless of
  // mobileOpen) but matters on mobile — otherwise the drawer would stay
  // open over the content you just chose to look at.
  const handleSelect = (pageId: string) => {
    onSelect(pageId);
    onMobileClose();
  };
  const handleSelectShared = (page: SharedPageItem) => {
    onSelectShared?.(page);
    onMobileClose();
  };

  return (
    <>
      {/* Backdrop — mobile only (md:hidden); starts below the header
          (h-12), not inset-0, so header content (hamburger, save status)
          stays reachable even while this is open. Irrelevant above md
          since the drawer itself is forced static/visible there
          regardless of mobileOpen, so there's nothing to dim behind. */}
      {mobileOpen && <div className="fixed inset-x-0 bottom-0 top-12 z-30 bg-black/30 md:hidden" onClick={onMobileClose} />}

      <aside
        className={`fixed bottom-0 left-0 top-12 z-40 flex h-auto w-64 flex-col border-r border-line/10 bg-surface-panel transition-transform duration-200 md:static md:inset-auto md:h-full md:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
      <div className="flex items-center gap-2 border-b border-line/10 px-3 py-3">
        {logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoSrc} alt={settings.siteName} style={{ height: HEADER_LOGO_HEIGHT }} className="max-w-[40px] shrink-0 object-contain" />
        ) : null}
        <span className="truncate text-sm font-semibold text-ink">{settings.siteName}</span>
      </div>

      <div className="p-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              onSearch(e.target.value);
            }}
            placeholder="Поиск по страницам..."
            className="w-full rounded-md border border-line/10 bg-surface py-1.5 pl-8 pr-2 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1 pb-3">
        {isLoading ? (
          <SidebarSkeleton />
        ) : searchResults ? (
          <SearchResults results={searchResults} onSelect={handleSelect} query={query} />
        ) : (
          <>
            {flatCount > VIRTUALIZE_THRESHOLD ? (
              <VirtualizedTree pages={pages} activePageId={activePageId} onSelect={handleSelect} onCreatePage={onCreatePage} onMovePage={onMovePage} onDeletePage={onDeletePage} />
            ) : (
              <Tree
                nodes={pages}
                depth={0}
                activePageId={activePageId}
                onSelect={handleSelect}
                onCreatePage={onCreatePage}
                onMovePage={onMovePage}
                onDeletePage={onDeletePage}
                parentId={null}
              />
            )}

            {sharedPages.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium uppercase text-ink-faint">
                  <Users size={11} />
                  Расшаренные со мной
                </div>
                <ul className="space-y-0.5 px-1">
                  {sharedPages.map((page) => (
                    <li key={`${page.ownerId}:${page.id}`}>
                      <button
                        type="button"
                        onClick={() => handleSelectShared(page)}
                        className={clsx(
                          'flex w-full items-center gap-1.5 rounded-md py-1 pl-2 pr-2 text-left text-sm',
                          activePageId === page.id ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                        )}
                      >
                        <PageIconDisplay icon={page.icon} size={14} fallback="📄" className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{page.title || 'Untitled'}</span>
                        <span className="shrink-0 truncate text-xs text-ink-faint">{page.ownerName}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-line/10 p-2">
        <button
          type="button"
          onClick={() => onCreatePage(null)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          <Plus size={14} />
          Новая страница
        </button>
      </div>
    </aside>
    </>
  );
}

function countNodes(nodes: PageNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

function SearchResults({ results, onSelect, query }: { results: { id: string; title: string }[]; onSelect: (id: string) => void; query: string }) {
  if (!query.trim()) return null;
  if (results.length === 0) {
    return <p className="px-3 py-4 text-sm text-ink-faint">Ничего не найдено по «{query}»</p>;
  }
  return (
    <ul className="animate-fadeIn space-y-0.5 px-1">
      {results.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onSelect(r.id)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-hover"
          >
            <FileText size={14} className="text-ink-faint" />
            <span className="truncate">{r.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface TreeProps {
  nodes: PageNode[];
  depth: number;
  activePageId: string | null;
  onSelect: (id: string) => void;
  onCreatePage: (parentId: string | null) => void;
  onMovePage: (pageId: string, newParentId: string | null, newOrder: number) => void;
  onDeletePage: (pageId: string) => void;
  parentId: string | null;
}

function Tree({ nodes, depth, activePageId, onSelect, onCreatePage, onMovePage, onDeletePage, parentId }: TreeProps) {
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  return (
    <ul
      onDragOver={(e) => {
        e.preventDefault();
        setDragOverId(parentId ?? 'root');
      }}
      onDrop={(e) => {
        e.preventDefault();
        const pageId = e.dataTransfer.getData('text/page-id');
        if (pageId) onMovePage(pageId, parentId, Date.now());
        setDragOverId(null);
      }}
      className={clsx('space-y-0.5', dragOverId === (parentId ?? 'root') && 'rounded-md bg-accent-soft/40')}
    >
      {nodes.map((node) => (
        <TreeItem
          key={node.id}
          node={node}
          depth={depth}
          activePageId={activePageId}
          onSelect={onSelect}
          onCreatePage={onCreatePage}
          onMovePage={onMovePage}
          onDeletePage={onDeletePage}
        />
      ))}
    </ul>
  );
}

function TreeItem({
  node,
  depth,
  activePageId,
  onSelect,
  onCreatePage,
  onMovePage,
  onDeletePage,
}: {
  node: PageNode;
  depth: number;
  activePageId: string | null;
  onSelect: (id: string) => void;
  onCreatePage: (parentId: string | null) => void;
  onMovePage: (pageId: string, newParentId: string | null, newOrder: number) => void;
  onDeletePage: (pageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/page-id', node.id)}
        onClick={() => onSelect(node.id)}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={clsx(
          'group flex cursor-pointer items-center gap-1 rounded-md py-1 pr-1 text-sm',
          activePageId === node.id ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
        )}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className={clsx('shrink-0 rounded p-0.5 hover:bg-surface-hover', !hasChildren && 'invisible')}
        >
          <ChevronRight size={12} className={clsx('transition-transform', expanded && 'rotate-90')} />
        </button>
        <PageIconDisplay icon={node.icon} size={14} fallback="📄" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{node.title || 'Untitled'}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCreatePage(node.id);
          }}
          title="Добавить дочернюю страницу"
          className="shrink-0 rounded p-0.5 opacity-0 hover:bg-surface hover:text-ink group-hover:opacity-100"
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Удалить страницу «${node.title || 'Untitled'}»? Вложенные страницы удалятся вместе с ней. Это необратимо.`)) {
              onDeletePage(node.id);
            }
          }}
          title="Удалить страницу"
          className="shrink-0 rounded p-0.5 opacity-0 hover:bg-surface hover:text-red-500 group-hover:opacity-100"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {hasChildren && expanded && (
        <Tree
          nodes={node.children}
          depth={depth + 1}
          activePageId={activePageId}
          onSelect={onSelect}
          onCreatePage={onCreatePage}
          onMovePage={onMovePage}
          onDeletePage={onDeletePage}
          parentId={node.id}
        />
      )}
    </li>
  );
}

/**
 * Lightweight windowed rendering for large sidebars (>100 pages): flattens
 * the visible (expanded) tree and only mounts rows within the scroll
 * viewport +/- a small buffer, instead of pulling in a virtualization
 * library for one list.
 */
function VirtualizedTree({
  pages,
  activePageId,
  onSelect,
  onCreatePage,
  onMovePage,
  onDeletePage,
}: {
  pages: PageNode[];
  activePageId: string | null;
  onSelect: (id: string) => void;
  onCreatePage: (parentId: string | null) => void;
  onMovePage: (pageId: string, newParentId: string | null, newOrder: number) => void;
  onDeletePage: (pageId: string) => void;
}) {
  const ROW_HEIGHT = 28;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  const flat = useMemo(() => {
    const rows: { node: PageNode; depth: number }[] = [];
    const walk = (nodes: PageNode[], depth: number) => {
      for (const n of nodes) {
        rows.push({ node: n, depth });
        walk(n.children, depth + 1); // simplified: large trees render expanded for virtualization
      }
    };
    walk(pages, 0);
    return rows;
  }, [pages]);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
  const endIndex = Math.min(flat.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + 5);
  const visible = flat.slice(startIndex, endIndex);

  return (
    <div
      className="relative h-full overflow-y-auto"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      ref={(el) => el && setViewportHeight(el.clientHeight)}
    >
      <div style={{ height: flat.length * ROW_HEIGHT, position: 'relative' }}>
        {visible.map(({ node, depth }, i) => (
          <div key={node.id} style={{ position: 'absolute', top: (startIndex + i) * ROW_HEIGHT, left: 0, right: 0 }}>
            <TreeItem
              node={{ ...node, children: [] }}
              depth={depth}
              activePageId={activePageId}
              onSelect={onSelect}
              onCreatePage={onCreatePage}
              onMovePage={onMovePage}
              onDeletePage={onDeletePage}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
