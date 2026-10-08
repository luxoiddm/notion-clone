'use client';

import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getLastLocation, saveLastLocation, clearLastLocation } from '../lib/lastLocation';
import { Check, CloudOff, Loader2, Share2, FolderOpen, MessageSquare, PanelRight, Plus, ChevronRight, ChevronLeft, Eye, Pencil, FileText, ArrowRight, Clock, Globe, FolderTree, Upload } from 'lucide-react';
import { MobileTabBar, MobileFab } from '../components/MobileTabBar';
import { useSession } from '../components/SessionProvider';
import { useUserStore } from '../store/useUserStore';
import { usePages } from '../hooks/usePages';
import { useDocument, createDocument } from '../hooks/useDocument';
import { usePresence } from '../hooks/usePresence';
import { Sidebar, type SharedPageItem } from '../components/Sidebar';
import { Editor } from '../components/Editor';
import { EditorSkeleton } from '../components/Skeleton';
import { PresenceAvatars } from '../components/PresenceAvatars';
import { PageIconDisplay } from '../components/PageIconDisplay';
import { ThemeToggle } from '../components/ThemeToggle';
import { CommentsPanel } from '../components/CommentsPanel';
import { DocumentSidebar } from '../components/DocumentSidebar';
import { useSiteSettings, logoUrlWithCacheBust, LOGIN_LOGO_HEIGHT, SiteLogo } from '../components/SiteSettingsProvider';
import { ShareDialog } from '../components/ShareDialog';
import { PublishDialog } from '../components/PublishDialog';
import { ToastProvider, useToast } from '../components/Toast';
import { api } from '../lib/api';
import type { PageMeta, PageNode, CurrentUser } from '../lib/types';

export default function Page() {
  return (
    <ToastProvider>
      <Suspense fallback={null}>
        <Workspace />
      </Suspense>
    </ToastProvider>
  );
}

function Workspace() {
  const { user, accessToken, isLoading: sessionLoading, login, logout } = useSession();
  const { projectId, setProjectId, activeOwnerId, activeProjectId, activePageId, openPage, clearActivePage } = useUserStore();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Keeps activePageId in sync with the URL's owner/project/page params
  // in *both* directions — restoring on first load (falling back to the
  // remembered last location when the URL itself has none, including
  // redirecting to /chat if that's genuinely where the user was), and
  // afterward reacting whenever those params change from outside this
  // effect's own doing — most importantly when the user presses the
  // browser's Back/Forward button, which changes the URL without this
  // component initiating anything itself.
  //
  // The first-run branch and the subsequent-runs branch both ultimately
  // call the same openPage()/clearActivePage() — split into two `if`
  // branches only because the very first run additionally needs the
  // localStorage fallback for a URL with no params at all (a fresh
  // login or a brand new tab has nothing to fall back to *in* the URL),
  // which no subsequent run should ever repeat.
  //
  // Comparing against the current activeOwnerId/activeProjectId/
  // activePageId before calling openPage on a subsequent run is what
  // keeps this from fighting with the mirroring effect below: that
  // effect pushes state *into* the URL, which re-fires this one via
  // `searchParams` changing — without the comparison, this would read
  // back the very params that effect just wrote and call openPage()
  // again for a page that's already open, bouncing the two effects off
  // each other forever.
  const hasRestoredFromUrl = useRef(false);
  useEffect(() => {
    if (!user) return;
    const owner = searchParams.get('owner');
    const project = searchParams.get('project');
    const page = searchParams.get('page');

    if (!hasRestoredFromUrl.current) {
      hasRestoredFromUrl.current = true;
      if (owner && project && page) {
        openPage(owner, project, page);
      } else {
        const last = getLastLocation();
        if (last?.route === 'chat') {
          router.replace(last.chatId ? `/chat?open=${encodeURIComponent(last.chatId)}` : '/chat');
        } else if (last?.route === 'editor') {
          openPage(last.ownerId, last.projectId, last.pageId);
        }
      }
      return;
    }

    if (owner && project && page) {
      if (owner !== activeOwnerId || project !== activeProjectId || page !== activePageId) {
        openPage(owner, project, page);
      }
    } else if (activeOwnerId || activeProjectId || activePageId) {
      clearActivePage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, searchParams, openPage]);

  // Mirrors the active page into the URL — the other half of the
  // two-way sync above. Pushes a new history entry for every real
  // navigation (a different owner/project/page than what's already in
  // the URL) so the browser's Back/Forward buttons actually retrace
  // documents visited via the sidebar or an in-text page-reference
  // link — clicking through pages used to `replace()` unconditionally,
  // which never added a history entry at all, so Back had nothing of
  // this app's own to go to. The very first sync is still a `replace`
  // (tracked by `hasMirroredOnce`) — that one just reflects whatever
  // page-restoration above already decided to open, not a "navigation"
  // the user actually took, so it shouldn't get its own Back-button stop.
  const hasMirroredOnce = useRef(false);
  useEffect(() => {
    if (!hasRestoredFromUrl.current) return;
    if (activeOwnerId && activeProjectId && activePageId) {
      saveLastLocation({ route: 'editor', ownerId: activeOwnerId, projectId: activeProjectId, pageId: activePageId });
    }
    const params = new URLSearchParams(window.location.search);
    if (activeOwnerId && activeProjectId && activePageId) {
      params.set('owner', activeOwnerId);
      params.set('project', activeProjectId);
      params.set('page', activePageId);
    } else {
      params.delete('owner');
      params.delete('project');
      params.delete('page');
    }
    // Skip the call entirely if nothing would actually change — an
    // unconditional push()/replace() on every fire, combined with
    // `router` not being a reliably stable reference across renders in
    // the App Router, is exactly what caused this effect to loop
    // indefinitely (each call triggers a render, which looked like
    // "router changed" to this effect's own dependency check, firing it
    // again). Deliberately not listing `router` as a dependency for the
    // same reason — standard practice for this specific hook.
    const nextSearch = `?${params.toString()}`;
    if (nextSearch !== window.location.search) {
      if (hasMirroredOnce.current) {
        router.push(nextSearch, { scroll: false });
      } else {
        router.replace(nextSearch, { scroll: false });
      }
    }
    hasMirroredOnce.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOwnerId, activeProjectId, activePageId]);
  /**
   * Target block for the scroll-and-highlight that follows opening a
   * page-reference link pointing at a specific block (see
   * `openPageRef` below and Editor.tsx's own `scrollToBlockId` prop
   * doc comment) — lives here rather than inside Editor itself since
   * the *navigation* half (openPage, when the link points at a
   * different page) has to happen up here regardless.
   */
  const [scrollToBlockId, setScrollToBlockId] = useState<string | null>(null);

  /**
   * Wraps `openPage` for page-reference links specifically — the only
   * caller that ever has a `blockId` to act on. When the link targets
   * the page already open, skips calling `openPage` entirely (it'd be a
   * same-value no-op via Zustand anyway, but this also sidesteps
   * needlessly re-triggering the URL-mirroring effect above) and just
   * sets `scrollToBlockId`, which Editor's own effect picks up
   * immediately since the target content is already loaded.
   */
  const openPageRef = (ownerId: string, projectId: string, pageId: string, blockId?: string) => {
    setScrollToBlockId(blockId ?? null);
    if (ownerId === activeOwnerId && projectId === activeProjectId && pageId === activePageId) return;
    openPage(ownerId, projectId, pageId);
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PageMeta[] | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [sharedPages, setSharedPages] = useState<SharedPageItem[]>([]);
  const [usersById, setUsersById] = useState<Map<string, { displayName: string; avatarUrl: string | null }>>(new Map());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Defaults the document sidebar to closed on a narrow viewport — it'd
  // otherwise pop up as a full-width overlay covering the article on
  // every single page load on mobile. Runs once, after mount: adjusting
  // useState's *initial* value directly from window.innerWidth would
  // mismatch between server and client render (window doesn't exist
  // during SSR), this way the first render always matches (open, same
  // as desktop) and only adjusts once real viewport info is available.
  useEffect(() => {
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, []);
  const { push } = useToast();

  const { pages, isLoading: pagesLoading, refresh, renameNode } = usePages(user?.id ?? null, projectId);
  const doc = useDocument(activeOwnerId, activeProjectId, activePageId);
  const presenceUsers = usePresence(accessToken, activeProjectId, activePageId);

  const isOwnDocument = !!user && activeOwnerId === user.id;

  // Хлебные крошки: путь от корня дерева до открытой страницы. Для чужой
  // (расшаренной) страницы дерева нет — показываем только её саму.
  const breadcrumbTrail = useMemo(() => {
    if (!activePageId) return [];
    const path = isOwnDocument ? findPath(pages, activePageId) : null;
    if (path && path.length) return path.map((n) => ({ id: n.id, title: n.title, icon: n.icon }));
    return [{ id: activePageId, title: doc.meta?.title ?? '', icon: doc.meta?.icon ?? null }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, activePageId, isOwnDocument, doc.meta?.title, doc.meta?.icon]);
  const canEdit =
    isOwnDocument ||
    (!!doc.meta && !!user && doc.meta.sharing.some((s) => (s.userId === user.id || s.userId === '*') && (s.level === 'edit' || s.level === 'admin')));

  // Bootstrap: once logged in, pick the user's first project (or create their
  // default one) so the sidebar/editor have something to load.
  useEffect(() => {
    if (!user || projectId) return;
    (async () => {
      const projects = await api.listProjects(user.id);
      const project = projects[0] ?? (await api.createProject(user.id, 'Моё пространство'));
      setProjectId(project.id);
    })();
  }, [user, projectId, setProjectId]);

  // The unified "board": everything shared with me, across every other
  // user's workspace, shown in the sidebar below my own tree. Also keeps
  // usersById around (not just the shared-pages owner-name lookup it was
  // originally for) — CommentsPanel needs it to resolve comment authors'
  // names/avatars.
  useEffect(() => {
    if (!user) return;
    Promise.all([api.listShared(), api.listUsersDirectory()])
      .then(([shared, directory]) => {
        const byId = new Map(directory.map((u) => [u.id, { displayName: u.displayName, avatarUrl: u.avatarUrl }]));
        setUsersById(byId);
        setSharedPages(shared.map((p) => ({ ...p, ownerName: byId.get(p.ownerId)?.displayName ?? p.ownerId })));
      })
      .catch(() => setSharedPages([]));
  }, [user]);

  useEffect(() => {
    if (doc.saveStatus === 'error') push('Не удалось сохранить изменения', 'error');
  }, [doc.saveStatus, push]);

  // Mirrors the title into the sidebar tree the instant it changes in
  // the editor — doc.setTitle debounces the actual save to the server by
  // design (typing shouldn't fire a request per keystroke), but the
  // sidebar shouldn't visibly lag behind by that same few seconds, let
  // alone wait for a full tree refetch that was never triggered at all
  // for a plain rename (only create/move/delete call refresh()).
  //
  // Depends on doc.meta?.id / doc.meta?.title specifically — both plain
  // strings, compared by value — not the whole doc.meta object. Reading
  // useDocument's own return statement: it deliberately rebuilds meta as
  // a fresh object literal (`{ ...meta, title }`) on every single render,
  // to always overlay the live-typed title for callers. That means
  // doc.meta's reference is never stable across renders even when
  // nothing has changed — depending on the whole object here caused this
  // effect to refire on every render unconditionally, calling
  // renameNode() → setPages() in usePages → another render → repeat,
  // an infinite loop ("Maximum update depth exceeded").
  useEffect(() => {
    if (activePageId && doc.meta && doc.meta.id === activePageId) renameNode(activePageId, doc.meta.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePageId, doc.meta?.id, doc.meta?.title, renameNode]);

  useEffect(() => {
    if (!user || !projectId || !searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const handle = setTimeout(() => {
      api.search(user.id, projectId, searchQuery).then(setSearchResults).catch(() => setSearchResults([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [searchQuery, user, projectId]);

  if (sessionLoading) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-surface text-ink-faint">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onLogin={(u, token) => login(u, token)} />;
  }

  const handleCreatePage = async (parentId: string | null) => {
    if (!projectId) return;
    try {
      const page = await createDocument(user.id, projectId, { parentId });
      await refresh();
      openPage(user.id, projectId, page.id);
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось создать страницу', 'error');
    }
  };

  const handleMovePage = async (pageId: string, newParentId: string | null, newOrder: number) => {
    if (!projectId) return;
    try {
      await api.movePage(user.id, projectId, pageId, newParentId, newOrder);
      await refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось переместить страницу', 'error');
    }
  };

  const handleDeletePage = async (pageId: string) => {
    if (!projectId) return;
    if (activePageId === pageId) clearActivePage();
    await api.deletePage(user.id, projectId, pageId);
    await refresh();
    push('Страница удалена', 'success');
  };

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-surface">
      <Sidebar
        pages={pages}
        isLoading={pagesLoading}
        activePageId={activePageId}
        onSelect={(pageId) => projectId && openPage(user.id, projectId, pageId)}
        onCreatePage={handleCreatePage}
        onMovePage={handleMovePage}
        onDeletePage={handleDeletePage}
        onSearch={setSearchQuery}
        searchResults={searchResults?.map((r) => ({ id: r.id, title: r.title })) ?? null}
        sharedPages={sharedPages}
        onSelectShared={(page) => openPage(page.ownerId, page.projectId, page.id)}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className={`h-12 shrink-0 items-center justify-between gap-3 border-b border-line/[0.07] px-2 sm:px-4 ${activePageId ? 'flex' : 'hidden md:flex'}`}
        >
          <div className="flex min-w-0 items-center gap-1 text-sm md:gap-2">
            <button
              type="button"
              onClick={() => {
                clearLastLocation();
                clearActivePage();
              }}
              title="Назад"
              aria-label="Назад"
              className="btn-icon md:hidden"
            >
              <ChevronLeft size={22} />
            </button>
            {activePageId ? (
              <Breadcrumbs
                trail={breadcrumbTrail}
                ownerName={!isOwnDocument && activeOwnerId ? usersById.get(activeOwnerId)?.displayName ?? null : null}
                onSelect={(id) => projectId && openPage(user.id, projectId, id)}
              />
            ) : (
              <span className="px-1 font-medium text-ink">Главная</span>
            )}
            {activePageId && !isOwnDocument && (
              <span className={canEdit ? 'badge-accent' : 'badge'}>
                {canEdit ? <Pencil size={10} /> : <Eye size={10} />}
                <span className="hidden sm:inline">{canEdit ? 'Можно редактировать' : 'Только чтение'}</span>
              </span>
            )}
            <SaveIndicator status={doc.saveStatus} />
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <div className="mr-1 hidden sm:block">
              <PresenceAvatars users={presenceUsers} currentUserId={user.id} />
            </div>

            {activePageId && canEdit && !doc.isLoading && (
              <button type="button" onClick={() => setPublishOpen(true)} title="Опубликовать в публичный раздел" className="btn-secondary btn-sm h-8 px-3">
                <Globe size={14} />
                <span className="hidden sm:inline">Опубликовать</span>
              </button>
            )}

            {activePageId && isOwnDocument && (
              <button type="button" onClick={() => setShareOpen(true)} title="Поделиться" className="btn-primary btn-sm h-8 px-3">
                <Share2 size={14} />
                <span className="hidden sm:inline">Поделиться</span>
              </button>
            )}

            {activePageId && (
              <button type="button" onClick={() => setMobileNavOpen(true)} title="Мои страницы" aria-label="Мои страницы" className="btn-icon md:hidden">
                <FolderTree size={18} />
              </button>
            )}

            {activePageId && !doc.isLoading && (
              <button
                type="button"
                onClick={() => setSidebarOpen((v) => !v)}
                title={sidebarOpen ? 'Скрыть панель документа' : 'Показать панель документа'}
                className={`btn-icon ${sidebarOpen ? 'bg-surface-hover text-ink' : ''}`}
              >
                <PanelRight size={16} />
              </button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className={`flex-1 overflow-y-auto ${activePageId ? '' : 'pb-tabbar md:pb-0'}`}>
            {!activePageId ? (
              <HomeDashboard
                onOpenTree={() => setMobileNavOpen(true)}
                userName={user.displayName}
                pages={pages}
                sharedPages={sharedPages}
                isLoading={pagesLoading}
                onCreate={() => handleCreatePage(null)}
                onOpen={(id) => projectId && openPage(user.id, projectId, id)}
                onOpenShared={(p) => openPage(p.ownerId, p.projectId, p.id)}
              />
            ) : doc.isLoading ? (
              <EditorSkeleton />
            ) : (
              <Editor
                title={doc.meta?.title ?? ''}
                onTitleChange={doc.setTitle}
                icon={doc.meta?.icon ?? null}
                onIconChange={(icon) => void doc.setIcon(icon)}
                cover={doc.meta?.coverImage ?? null}
                onCoverChange={(cover) => void doc.setCover(cover)}
                uploadCoverImage={doc.uploadAsset}
                blocks={doc.blocks}
                onBlocksChange={doc.setBlocks}
                readOnly={!canEdit}
                currentUserId={user.id}
                onOpenPageRef={openPageRef}
                scrollToBlockId={scrollToBlockId}
                onScrolledToBlock={() => setScrollToBlockId(null)}
              />
            )}
            {activePageId && !doc.isLoading && activeOwnerId && activeProjectId && user && (
              <CommentsPanel
                ownerId={activeOwnerId}
                projectId={activeProjectId}
                pageId={activePageId}
                currentUserId={user.id}
                usersById={usersById}
              />
            )}
          </div>

          {activePageId && activeOwnerId && activeProjectId && !doc.isLoading && sidebarOpen && (
            <DocumentSidebar
              icon={doc.meta?.icon ?? null}
              onIconChange={(icon) => void doc.setIcon(icon)}
              tags={doc.meta?.tags ?? []}
              onTagsChange={(tags) => void doc.setTags(tags)}
              blocks={doc.blocks}
              title={doc.meta?.title ?? ''}
              ownerId={activeOwnerId}
              projectId={activeProjectId}
              pageId={activePageId}
              usersById={usersById}
              onRestored={() => void doc.reload()}
              readOnly={!canEdit}
              onClose={() => setSidebarOpen(false)}
            />
          )}
        </div>
      </main>

      {!activePageId && (
        <>
          <MobileTabBar />
          <MobileFab icon={<Plus size={26} />} label="Новая страница" onClick={() => void handleCreatePage(null)} />
        </>
      )}

      {publishOpen && activePageId && activeOwnerId && activeProjectId && (
        <PublishDialog
          ownerId={activeOwnerId}
          projectId={activeProjectId}
          pageId={activePageId}
          pageTitle={doc.meta?.title ?? ''}
          canManage={user.role === 'Admin' || user.role === 'Team-Lead'}
          onClose={() => setPublishOpen(false)}
        />
      )}

      {shareOpen && activePageId && activeProjectId && isOwnDocument && doc.meta && (
        <ShareDialog
          ownerId={user.id}
          projectId={activeProjectId}
          pageId={activePageId}
          sharing={doc.meta.sharing}
          onClose={() => setShareOpen(false)}
          onChanged={() => undefined}
        />
      )}
    </div>
  );
}

function SaveIndicator({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (status === 'saving') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-faint">
        <Loader2 size={12} className="animate-spin" />
        <span className="hidden sm:inline">Сохранение…</span>
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="flex shrink-0 animate-fadeIn items-center gap-1 text-xs text-ink-faint">
        <Check size={12} />
        <span className="hidden sm:inline">Сохранено</span>
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-danger">
        <CloudOff size={12} /> Ошибка сохранения
      </span>
    );
  }
  return null;
}

function findPath(nodes: PageNode[], id: string): PageNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return [n];
    const sub = findPath(n.children, id);
    if (sub) return [n, ...sub];
  }
  return null;
}

function flatten(nodes: PageNode[]): PageNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

function Breadcrumbs({
  trail,
  ownerName,
  onSelect,
}: {
  trail: { id: string; title: string; icon: string | null }[];
  ownerName: string | null;
  onSelect: (id: string) => void;
}) {
  // На узком экране — только последний элемент, на широком — сворачиваем
  // середину длинного пути в «…».
  const items = trail.length > 3 ? [trail[0]!, null, ...trail.slice(-2)] : trail;
  return (
    <nav className="flex min-w-0 items-center gap-0.5" aria-label="Путь к странице">
      {ownerName && (
        <>
          <span className="hidden shrink-0 px-1 text-ink-faint sm:inline">{ownerName}</span>
          <ChevronRight size={13} className="hidden shrink-0 text-ink-faint/70 sm:block" />
        </>
      )}
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        if (!item) {
          return (
            <span key={`gap-${i}`} className="hidden items-center gap-0.5 sm:flex">
              <span className="px-1 text-ink-faint">…</span>
              <ChevronRight size={13} className="shrink-0 text-ink-faint/70" />
            </span>
          );
        }
        return (
          <span key={item.id} className={`min-w-0 items-center gap-0.5 ${isLast ? 'flex' : 'hidden sm:flex'}`}>
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              disabled={isLast || !!ownerName}
              className={`flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors ${
                isLast ? 'font-medium text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
              }`}
            >
              <span className="shrink-0 text-[14px] leading-none">
                <PageIconDisplay icon={item.icon} size={14} fallback={<FileText size={13} className="text-ink-faint" />} />
              </span>
              <span className="max-w-[220px] truncate">{item.title || 'Без названия'}</span>
            </button>
            {!isLast && <ChevronRight size={13} className="shrink-0 text-ink-faint/70" />}
          </span>
        );
      })}
    </nav>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} дн назад`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Главная без открытой страницы: приветствие, быстрые действия, недавние документы. */
function HomeDashboard({
  onOpenTree,
  userName,
  pages,
  sharedPages,
  isLoading,
  onCreate,
  onOpen,
  onOpenShared,
}: {
  onOpenTree: () => void;
  userName: string;
  pages: PageNode[];
  sharedPages: SharedPageItem[];
  isLoading: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onOpenShared: (page: SharedPageItem) => void;
}) {
  const recent = useMemo(
    () => [...flatten(pages)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6),
    [pages],
  );
  const firstName = userName.split(' ')[0] ?? userName;

  const quick = [
    { icon: Plus, title: 'Новая страница', desc: 'Пустой документ в вашем пространстве', onClick: onCreate, primary: true },
    { icon: MessageSquare, title: 'Сообщения', desc: 'Чаты и видеозвонки с командой', href: '/chat' },
    { icon: FolderOpen, title: 'Файлы', desc: 'Личное хранилище изображений и документов', href: '/files' },
  ];

  return (
    <div className="mx-auto w-full max-w-4xl animate-fadeIn px-4 pb-16 pt-6 sm:px-8 md:pt-16">
      <p className="text-sm text-ink-faint">
        {new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
      </p>
      <h1 className="mt-1 text-[28px] font-bold tracking-[-0.02em] text-ink md:font-semibold">
        {greeting()}, {firstName}
      </h1>

      {/* Телефон: быстрые действия плитками в ряд, «Мои страницы» открывает шторку с деревом. */}
      <div className="mt-5 grid grid-cols-3 gap-2.5 md:hidden">
        {[
          { icon: Plus, title: 'Новая страница', onClick: onCreate, tint: 'bg-accent-soft text-accent-ink' },
          { icon: FolderTree, title: 'Мои страницы', onClick: onOpenTree, tint: 'bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300' },
          { icon: Upload, title: 'Загрузить файл', href: '/files', tint: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300' },
        ].map(({ icon: Icon, title, onClick, href, tint }) => {
          const inner = (
            <>
              <span className={`flex h-8 w-8 items-center justify-center rounded-[10px] ${tint}`}>
                <Icon size={17} />
              </span>
              <span className="text-[13px] font-semibold leading-tight text-ink">{title}</span>
            </>
          );
          const cls = 'flex h-[92px] flex-col justify-between rounded-2xl border border-line/[0.07] bg-surface-panel p-3 text-left active:bg-surface-hover';
          return href ? (
            <Link key={title} href={href} className={cls}>
              {inner}
            </Link>
          ) : (
            <button key={title} type="button" onClick={onClick} className={cls}>
              {inner}
            </button>
          );
        })}
      </div>

      <div className="mt-8 hidden gap-2.5 sm:grid-cols-3 sm:gap-3 md:grid">
        {quick.map(({ icon: Icon, title, desc, onClick, href, primary }) => {
          const inner = (
            <>
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  primary ? 'bg-accent text-white shadow-xs' : 'bg-surface-sunken text-ink-muted group-hover:text-accent'
                } transition-colors`}
              >
                <Icon size={17} />
              </span>
              <span className="min-w-0 sm:mt-4 sm:block">
                <span className="block text-sm font-medium text-ink">{title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{desc}</span>
              </span>
            </>
          );
          const cls =
            'group card flex items-center gap-3 p-3.5 text-left transition-[box-shadow,transform,border-color] hover:-translate-y-px hover:border-line/[0.14] hover:shadow-pop sm:block sm:p-4';
          return href ? (
            <Link key={title} href={href} className={cls}>
              {inner}
            </Link>
          ) : (
            <button key={title} type="button" onClick={onClick} className={cls}>
              {inner}
            </button>
          );
        })}
      </div>

      <section className="mt-12">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Clock size={15} className="text-ink-faint" />
            Недавние
          </h2>
        </div>
        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-[104px] animate-shimmer rounded-xl" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed border-line/[0.12] px-6 py-12 text-center">
            <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-sunken text-ink-faint">
              <FileText size={20} />
            </span>
            <p className="text-sm font-medium text-ink">Здесь появятся ваши документы</p>
            <p className="mt-1 text-sm text-ink-muted">Создайте первую страницу — заметку, регламент или план проекта.</p>
            <button type="button" onClick={onCreate} className="btn-primary mt-5">
              <Plus size={15} /> Создать страницу
            </button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recent.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onOpen(p.id)}
                title={p.title || 'Без названия'}
                className="group card flex h-[104px] items-center gap-4 p-3.5 text-left transition-[box-shadow,transform,border-color] hover:-translate-y-px hover:border-line/[0.14] hover:shadow-pop"
              >
                {/* Ярлык — на всю высоту карточки: он и есть «лицо» документа. */}
                <span className={`flex h-[76px] w-[76px] shrink-0 items-center justify-center overflow-hidden rounded-lg text-[52px] leading-none ${p.icon ? "" : "bg-surface-sunken/60"}`}>
                  <PageIconDisplay
                    icon={p.icon}
                    size={64}
                    className="flex h-16 w-16 items-center justify-center object-contain"
                    fallback={<FileText size={34} strokeWidth={1.5} className="text-ink-faint" />}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col justify-center">
                  <span className="line-clamp-3 text-sm font-medium leading-snug text-ink [overflow-wrap:anywhere]">{p.title || 'Без названия'}</span>
                  <span className="mt-1 block text-xs text-ink-faint">Изменено {relativeTime(p.updatedAt)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {sharedPages.length > 0 && (
        <section className="mt-12">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Доступные мне</h2>
            <Link href="/shared" className="flex items-center gap-1 text-xs text-ink-muted hover:text-ink">
              Все <ArrowRight size={12} />
            </Link>
          </div>
          <div className="card divide-y divide-line/[0.06] overflow-hidden">
            {sharedPages.slice(0, 5).map((p) => (
              <button
                key={`${p.ownerId}:${p.id}`}
                type="button"
                onClick={() => onOpenShared(p)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
              >
                <span className="text-[16px] leading-none">
                  <PageIconDisplay icon={p.icon} size={18} fallback={<FileText size={16} className="text-ink-faint" />} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{p.title || 'Без названия'}</span>
                <span className="shrink-0 text-xs text-ink-faint">{p.ownerName}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (user: CurrentUser, token: string) => void }) {
  const { settings } = useSiteSettings();
  const logoSrc = logoUrlWithCacheBust(settings, 'login');
  const bgSrc = logoUrlWithCacheBust(settings, 'login-bg');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Не удалось войти');
      onLogin(data.user, data.accessToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти');
    } finally {
      setIsSubmitting(false);
    }
  };

  const initial = settings.siteName.trim().slice(0, 1).toUpperCase() || 'W';

  return (
    <div className="relative flex min-h-[100dvh] flex-col bg-surface-panel">
      {bgSrc ? (
        // Фоновое фото из админки — на весь экран, обрезается по краям
        // (cover). Лёгкое затемнение — чтобы подпись внизу читалась на
        // любом фото; сама форма непрозрачная.
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={bgSrc} alt="" aria-hidden className="pointer-events-none fixed inset-0 h-full w-full object-cover" />
          <div className="pointer-events-none fixed inset-0 bg-black/20" />
        </>
      ) : (
        /* Мягкий акцентный фон — без отдельной колонки с описанием */
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_0%,rgb(var(--accent)/0.10),transparent_70%)]" />
      )}

      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle />
      </div>

      <div className="relative flex flex-1 flex-col items-center justify-center px-5 py-12">
        {/* На фоновом фото логотип переезжает внутрь непрозрачной карточки —
            поверх произвольной картинки он мог бы потеряться. */}
        <div className={`mb-8 animate-fadeIn justify-center ${bgSrc ? 'hidden' : 'flex'}`}>
          {logoSrc ? (
            <SiteLogo settings={settings} kind="login" style={{ height: LOGIN_LOGO_HEIGHT }} className="max-w-[min(360px,90vw)] object-contain" />
          ) : (
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent/70 text-2xl font-bold text-white shadow-pop">
              {initial}
            </span>
          )}
        </div>

        <form
          onSubmit={handleSubmit}
          className={`card w-full max-w-[400px] animate-popIn p-7 shadow-dialog sm:p-8 ${bgSrc ? 'relative border-transparent bg-surface-raised' : ''}`}
        >
          {bgSrc && (
            <div className="mb-6 flex justify-center">
              {logoSrc ? (
                <SiteLogo settings={settings} kind="login" style={{ height: Math.min(LOGIN_LOGO_HEIGHT, 72) }} className="max-w-full object-contain" />
              ) : (
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent/70 text-xl font-bold text-white shadow-pop">
                  {initial}
                </span>
              )}
            </div>
          )}
          <h1 className="text-center text-xl font-semibold tracking-[-0.015em] text-ink">Вход в {settings.siteName}</h1>
          <p className="mt-1.5 text-center text-sm text-ink-muted">Войдите с рабочей учётной записью</p>

          <div className="mt-7 space-y-4">
            <div>
              <label htmlFor="login-email" className="label">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                required
                autoComplete="email"
                autoFocus
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input h-10"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="label">
                Пароль
              </label>
              <input
                id="login-password"
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input h-10"
              />
            </div>
          </div>

          {error && (
            <p className="mt-4 flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
              <CloudOff size={14} className="shrink-0" />
              {error}
            </p>
          )}

          <button type="submit" disabled={isSubmitting} className="btn-primary btn-lg mt-6 w-full">
            {isSubmitting && <Loader2 size={15} className="animate-spin" />}
            Войти
          </button>

          <p className="mt-5 text-center text-xs leading-relaxed text-ink-faint">
            Нет доступа? Обратитесь к администратору за приглашением.
          </p>
        </form>
      </div>

      {(settings.copyrightText || settings.version) && (
        <div className={`relative pb-6 text-center text-xs ${bgSrc ? 'text-white/85 [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]' : 'text-ink-faint'}`}>
          {settings.copyrightText}
          {settings.copyrightText && settings.version && ' · '}
          {settings.version && `v${settings.version}`}
        </div>
      )}
    </div>
  );
}
