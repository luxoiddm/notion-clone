'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileText, Plus, Search, Trash2, SquarePen, X } from 'lucide-react';
import clsx from 'clsx';
import type { PageNode } from '../lib/types';
import { SidebarSkeleton } from './Skeleton';
import { PageIconDisplay } from './PageIconDisplay';
import { WorkspaceBrand, PrimaryNav, UserMenu } from './AppNav';

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
  const parentMap = useMemo(() => buildParentMap(pages), [pages]);

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

  // Ctrl/Cmd+K — фокус на поиске из любого места главной.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {/* Затемнение под выезжающей панелью — только на мобильных. */}
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] animate-overlayIn md:hidden" onClick={onMobileClose} />}

      {/* Телефон: дерево страниц — нижняя шторка («Мои страницы»); компьютер — постоянный сайдбар. */}
      <aside
        aria-label="Мои страницы"
        className={clsx(
          'fixed inset-x-0 bottom-0 top-14 z-50 flex flex-col rounded-t-3xl bg-surface shadow-dialog transition-transform duration-300 ease-out',
          'md:static md:inset-auto md:z-auto md:h-full md:w-[260px] md:shrink-0 md:translate-y-0 md:rounded-none md:border-r md:border-line/[0.07] md:bg-surface-panel md:shadow-none md:transition-none',
          mobileOpen ? 'translate-y-0' : 'translate-y-[110%]',
        )}
      >
        <div className="mx-auto mt-2 h-[5px] w-10 shrink-0 rounded-full bg-ink/15 md:hidden" />
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-2 md:hidden">
          <h2 className="text-xl font-bold text-ink">Мои страницы</h2>
          <div className="flex items-center">
            <button type="button" onClick={() => onCreatePage(null)} aria-label="Новая страница" className="btn-icon text-accent">
              <Plus size={20} />
            </button>
            <button type="button" onClick={onMobileClose} className="btn-icon" aria-label="Закрыть">
              <X size={20} />
            </button>
          </div>
        </div>
        <div className="hidden min-h-[56px] shrink-0 items-center justify-between gap-2 px-2.5 py-1.5 md:flex">
          <WorkspaceBrand />
          <div className="flex items-center gap-0.5">
            <button type="button" onClick={() => onCreatePage(null)} title="Новая страница" className="btn-icon h-7 w-7">
              <SquarePen size={15} />
            </button>
          </div>
        </div>

        <div className="px-4 pb-2 pt-1 md:px-2.5">
          <div className="group relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                onSearch(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('');
                  onSearch('');
                  e.currentTarget.blur();
                }
              }}
              placeholder="Поиск"
              className="h-11 w-full rounded-xl border border-line/[0.08] bg-surface-raised pl-8 pr-12 md:h-8 md:rounded-md text-sm text-ink shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-ink-faint focus:border-accent/60 focus:shadow-ring"
            />
            <span className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 gap-0.5 group-focus-within:hidden md:flex">
              <kbd className="kbd">{isMac ? '⌘' : 'Ctrl'}</kbd>
              <kbd className="kbd">K</kbd>
            </span>
          </div>
        </div>

        <div className="hidden px-2.5 pb-1 md:block">
          <PrimaryNav onNavigate={onMobileClose} />
        </div>

        <ParentMapContext.Provider value={parentMap}>
        <div className="flex-1 overflow-y-auto px-3 pb-[max(var(--safe-bottom),12px)] md:px-2.5 md:pb-3">
          {isLoading ? (
            <SidebarSkeleton />
          ) : searchResults ? (
            <SearchResults results={searchResults} onSelect={handleSelect} query={query} />
          ) : (
            <>
              <div className="group/section mb-1 mt-4 flex items-center justify-between pr-1">
                <span className="section-label">Мои страницы</span>
                <button
                  type="button"
                  onClick={() => onCreatePage(null)}
                  title="Новая страница"
                  className="btn-icon-sm opacity-0 transition-opacity group-hover/section:opacity-100"
                >
                  <Plus size={14} />
                </button>
              </div>
              {pages.length === 0 ? (
                <button
                  type="button"
                  onClick={() => onCreatePage(null)}
                  className="flex w-full items-center gap-2 rounded-md border border-dashed border-line/[0.12] px-2.5 py-2 text-left text-sm text-ink-muted transition-colors hover:border-accent/40 hover:text-ink"
                >
                  <Plus size={14} />
                  Создайте первую страницу
                </button>
              ) : flatCount > VIRTUALIZE_THRESHOLD ? (
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
                <div className="mt-5">
                  <div className="mb-1 flex items-center pr-1">
                    <span className="section-label">Доступные мне</span>
                  </div>
                  <ul className="space-y-px">
                    {sharedPages.map((page) => (
                      <li key={`${page.ownerId}:${page.id}`}>
                        <button
                          type="button"
                          onClick={() => handleSelectShared(page)}
                          className={clsx(
                            'flex h-[30px] w-full items-center gap-2 rounded-md pl-2 pr-2 text-left text-sm transition-colors',
                            activePageId === page.id ? 'bg-surface-hover font-medium text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                          )}
                        >
                          <span className="flex w-[18px] shrink-0 items-center justify-center text-[15px] leading-none"><PageIconDisplay icon={page.icon} size={16} fallback={<FileText size={15} className="text-ink-faint" />} /></span>
                          <span className="min-w-0 flex-1 truncate">{page.title || 'Без названия'}</span>
                          <span className="max-w-[80px] shrink-0 truncate text-2xs text-ink-faint">{page.ownerName.split(' ')[0]}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        </ParentMapContext.Provider>

        <div className="hidden shrink-0 border-t border-line/[0.06] p-2 md:block">
          <UserMenu />
        </div>
      </aside>
    </>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function countNodes(nodes: PageNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

function SearchResults({ results, onSelect, query }: { results: { id: string; title: string }[]; onSelect: (id: string) => void; query: string }) {
  if (!query.trim()) return null;
  if (results.length === 0) {
    return (
      <div className="px-2 py-8 text-center">
        <Search size={18} className="mx-auto mb-2 text-ink-faint" />
        <p className="text-sm text-ink-muted">Ничего не найдено по «{query}»</p>
      </div>
    );
  }
  return (
    <ul className="mt-3 animate-fadeIn space-y-px">
      <li className="section-label mb-1">Результаты</li>
      {results.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onSelect(r.id)}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-ink hover:bg-surface-hover"
          >
            <FileText size={15} className="shrink-0 text-ink-faint" />
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

/**
 * Перетаскивание в дереве страниц. Зона, куда опускается страница,
 * определяется по вертикали строки-цели:
 *   верхняя четверть  — вставить ПЕРЕД целью (тот же родитель),
 *   нижняя четверть   — вставить ПОСЛЕ цели (тот же родитель),
 *   середина          — сделать ДОЧЕРНЕЙ страницей цели.
 * Опускание на пустое место списка — в конец этого уровня.
 * Перетаскивать страницу внутрь её же потомков нельзя (получился бы цикл).
 */
type DropZone = 'before' | 'after' | 'inside';
let draggingPageId: string | null = null;

const ParentMapContext = createContext<Map<string, string | null>>(new Map());

function buildParentMap(nodes: PageNode[], parentId: string | null = null, map = new Map<string, string | null>()) {
  for (const n of nodes) {
    map.set(n.id, parentId);
    buildParentMap(n.children, n.id, map);
  }
  return map;
}

/** true, если `targetId` — это сама `pageId` или любая её вложенная страница. */
function isSelfOrDescendant(parentMap: Map<string, string | null>, pageId: string, targetId: string): boolean {
  let cur: string | null | undefined = targetId;
  while (cur) {
    if (cur === pageId) return true;
    cur = parentMap.get(cur);
  }
  return false;
}

function maxOrder(nodes: PageNode[]): number {
  return nodes.reduce((m, n) => Math.max(m, n.order), 0);
}

function Tree({ nodes, depth, activePageId, onSelect, onCreatePage, onMovePage, onDeletePage, parentId }: TreeProps) {
  const [isOver, setIsOver] = useState(false);
  const parentMap = useContext(ParentMapContext);

  return (
    <ul
      onDragOver={(e) => {
        if (!draggingPageId) return;
        if (parentId && isSelfOrDescendant(parentMap, draggingPageId, parentId)) return;
        e.preventDefault();
        setIsOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        const pageId = e.dataTransfer.getData('text/page-id') || draggingPageId;
        draggingPageId = null;
        if (!pageId || (parentId && isSelfOrDescendant(parentMap, pageId, parentId))) return;
        onMovePage(pageId, parentId, maxOrder(nodes) + 1);
      }}
      className={clsx('space-y-px rounded-md', depth === 0 && 'min-h-[24px] pb-4', isOver && depth === 0 && 'bg-accent-soft/30')}
    >
      {nodes.map((node, index) => (
        <TreeItem
          key={node.id}
          node={node}
          depth={depth}
          parentId={parentId}
          prevOrder={nodes[index - 1]?.order}
          nextOrder={nodes[index + 1]?.order}
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
  parentId = null,
  prevOrder,
  nextOrder,
  activePageId,
  onSelect,
  onCreatePage,
  onMovePage,
  onDeletePage,
}: {
  node: PageNode;
  depth: number;
  /** Родитель этой строки — нужен для вставки «перед/после». */
  parentId?: string | null;
  prevOrder?: number;
  nextOrder?: number;
  activePageId: string | null;
  onSelect: (id: string) => void;
  onCreatePage: (parentId: string | null) => void;
  onMovePage: (pageId: string, newParentId: string | null, newOrder: number) => void;
  onDeletePage: (pageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const parentMap = useContext(ParentMapContext);
  const hasChildren = node.children.length > 0;

  const zoneFor = (e: React.DragEvent<HTMLDivElement>): DropZone => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    if (y < 0.25) return 'before';
    if (y > 0.75) return 'after';
    return 'inside';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const zone = zoneFor(e);
    setDropZone(null);
    const pageId = e.dataTransfer.getData('text/page-id') || draggingPageId;
    draggingPageId = null;
    if (!pageId || isSelfOrDescendant(parentMap, pageId, node.id)) return;
    if (zone === 'inside') {
      onMovePage(pageId, node.id, maxOrder(node.children) + 1);
      setExpanded(true);
    } else if (zone === 'before') {
      onMovePage(pageId, parentId, prevOrder !== undefined ? (prevOrder + node.order) / 2 : node.order - 1);
    } else {
      onMovePage(pageId, parentId, nextOrder !== undefined ? (node.order + nextOrder) / 2 : node.order + 1);
    }
  };

  return (
    <li className="relative">
      {dropZone === 'before' && <div className="pointer-events-none absolute -top-px left-2 right-1 z-10 h-0.5 rounded bg-accent" style={{ marginLeft: depth * 16 }} />}
      {dropZone === 'after' && !(expanded && hasChildren) && (
        <div className="pointer-events-none absolute left-2 right-1 top-[30px] z-10 h-0.5 rounded bg-accent" style={{ marginLeft: depth * 16 }} />
      )}
      <div
        draggable
        onDragStart={(e) => {
          draggingPageId = node.id;
          e.dataTransfer.setData('text/page-id', node.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => {
          draggingPageId = null;
          setDropZone(null);
        }}
        onDragOver={(e) => {
          if (!draggingPageId || isSelfOrDescendant(parentMap, draggingPageId, node.id)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const zone = zoneFor(e);
          if (zone !== dropZone) setDropZone(zone);
        }}
        onDragLeave={() => setDropZone(null)}
        onDrop={handleDrop}
        onClick={() => onSelect(node.id)}
        style={{ paddingLeft: 4 + depth * 16 }}
        className={clsx(
          'group flex h-12 cursor-pointer items-center gap-1 rounded-xl pr-1 text-[15px] transition-colors md:h-[30px] md:rounded-md md:text-sm',
          dropZone === 'inside'
            ? 'bg-accent-soft text-ink ring-1 ring-inset ring-accent/50'
            : activePageId === node.id
              ? 'bg-surface-hover font-medium text-ink'
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
        )}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-label={expanded ? 'Свернуть' : 'Развернуть'}
          className={clsx('flex h-11 w-9 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-line/[0.08] hover:text-ink md:h-5 md:w-5', !hasChildren && 'invisible')}
        >
          <ChevronRight size={13} className={clsx('transition-transform duration-150', expanded && 'rotate-90')} />
        </button>
        <span className="flex w-7 shrink-0 items-center justify-center text-[22px] leading-none md:w-[18px] md:text-[15px]"><PageIconDisplay icon={node.icon} size={activeSize()} fallback={<FileText size={15} className="text-ink-faint" />} /></span>
        <span className="ml-1 min-w-0 flex-1 truncate">{node.title || 'Без названия'}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCreatePage(node.id);
          }}
          title="Добавить дочернюю страницу"
          className={clsx(
            'flex h-11 w-10 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 hover:bg-line/[0.08] hover:text-ink group-hover:opacity-100 md:h-5 md:w-5',
            activePageId === node.id && 'max-md:opacity-100',
          )}
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Удалить страницу «${node.title || 'Без названия'}»? Вложенные страницы удалятся вместе с ней. Это необратимо.`)) {
              onDeletePage(node.id);
            }
          }}
          title="Удалить страницу"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 hover:bg-line/[0.08] hover:text-danger group-hover:opacity-100"
        >
          <Trash2 size={13} />
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
  const ROW_HEIGHT = 31;
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
      ref={(el) => {
        if (el) setViewportHeight(el.clientHeight);
      }}
    >
      <div style={{ height: flat.length * ROW_HEIGHT, position: 'relative' }}>
        {visible.map(({ node, depth }, i) => (
          <div key={node.id} style={{ position: 'absolute', top: (startIndex + i) * ROW_HEIGHT, left: 0, right: 0 }}>
            <TreeItem
              parentId={node.parentId}
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

/** Размер ярлыка страницы в дереве: на телефоне крупнее (строка 48px). */
function activeSize(): number {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches ? 22 : 16;
}
