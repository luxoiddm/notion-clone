'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getLastLocation, saveLastLocation } from '../lib/lastLocation';
import { Cloud, CloudOff, Loader2, Share2, Users, ShieldCheck, LogOut, FolderOpen, MessageSquare, PanelRight, Menu, Globe } from 'lucide-react';
import { useSession } from '../components/SessionProvider';
import { useUserStore } from '../store/useUserStore';
import { usePages } from '../hooks/usePages';
import { useDocument, createDocument } from '../hooks/useDocument';
import { usePresence } from '../hooks/usePresence';
import { Sidebar, type SharedPageItem } from '../components/Sidebar';
import { Editor } from '../components/Editor';
import { EditorSkeleton } from '../components/Skeleton';
import { PresenceAvatars } from '../components/PresenceAvatars';
import { ThemeToggle } from '../components/ThemeToggle';
import { Avatar } from '../components/Avatar';
import { CommentsPanel } from '../components/CommentsPanel';
import { DocumentSidebar } from '../components/DocumentSidebar';
import { useSiteSettings, logoUrlWithCacheBust, LOGIN_LOGO_HEIGHT } from '../components/SiteSettingsProvider';
import { ShareDialog } from '../components/ShareDialog';
import { ToastProvider, useToast } from '../components/Toast';
import { api } from '../lib/api';
import type { PageMeta, CurrentUser } from '../lib/types';

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

  // Restoring which page was open survives a refresh only because it's
  // mirrored into the URL below — activePageId itself is plain client
  // state (Zustand), which a hard reload wipes just like any other
  // in-memory variable. Runs once, guarded by the ref so it doesn't
  // fight with openPage() calls made afterward for other reasons
  // (selecting a different page, and so on).
  //
  // Falls back to the remembered last location (localStorage, survives
  // a fresh login or a brand new tab, unlike the URL params, which only
  // help for a same-tab refresh) when the URL itself has no explicit
  // owner/project/page — including redirecting to /chat if that's
  // genuinely where the user was, not just defaulting to nothing.
  const hasRestoredFromUrl = useRef(false);
  useEffect(() => {
    if (hasRestoredFromUrl.current || !user) return;
    const owner = searchParams.get('owner');
    const project = searchParams.get('project');
    const page = searchParams.get('page');
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
    hasRestoredFromUrl.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, searchParams, openPage]);

  // Mirrors the active page into the URL — replace, not push, so
  // clicking through pages doesn't spam the browser's back-button
  // history with one entry per page. Held off until the restore effect
  // above has actually run once, so this can't clear the URL's own
  // owner/project/page params before they've been read on first load.
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
    // unconditional replace() on every fire, combined with `router` not
    // being a reliably stable reference across renders in the App
    // Router, is exactly what caused this effect to loop indefinitely
    // (each replace() triggers a render, which looked like "router
    // changed" to this effect's own dependency check, firing it again).
    // Deliberately not listing `router` as a dependency for the same
    // reason — standard practice for this specific hook.
    const nextSearch = `?${params.toString()}`;
    if (nextSearch !== window.location.search) {
      router.replace(nextSearch, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOwnerId, activeProjectId, activePageId]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PageMeta[] | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
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
    if (doc.saveStatus === 'saved') push('Изменения сохранены');
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
      <div className="flex h-screen items-center justify-center bg-surface text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
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
    <div className="flex h-screen w-full overflow-hidden bg-surface">
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
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line/10 px-4">
          <div className="flex items-center gap-2 text-sm text-ink-muted">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              title="Открыть меню"
              className="mr-1 rounded-md border border-line/10 p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink md:hidden"
            >
              <Menu size={14} />
            </button>
            <SaveIndicator status={doc.saveStatus} />
            {activePageId && !isOwnDocument && (
              <span className="rounded-md border border-line/10 px-2 py-0.5 text-xs text-ink-muted">
                {canEdit ? 'Общий доступ · редактирование' : 'Только чтение'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 sm:gap-3">
            <div className="hidden sm:block">
              <PresenceAvatars users={presenceUsers} currentUserId={user.id} />
            </div>

            <Link
              href="/chat"
              title="Чат"
              className="flex items-center gap-1.5 rounded-md border border-line/10 px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink sm:px-2.5"
            >
              <MessageSquare size={12} />
              <span className="hidden sm:inline">Чат</span>
            </Link>

            <Link
              href="/files"
              title="Файлы"
              className="flex items-center gap-1.5 rounded-md border border-line/10 px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink sm:px-2.5"
            >
              <FolderOpen size={12} />
              <span className="hidden sm:inline">Файлы</span>
            </Link>

            <Link
              href="/shared"
              title="Расшаренные"
              className="flex items-center gap-1.5 rounded-md border border-line/10 px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink sm:px-2.5"
            >
              <Users size={12} />
              <span className="hidden sm:inline">Расшаренные</span>
            </Link>

            {user.role === 'Admin' && (
              <Link
                href="/admin"
                title="Админ-панель"
                className="flex items-center gap-1.5 rounded-md border border-line/10 px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink sm:px-2.5"
              >
                <ShieldCheck size={12} />
                <span className="hidden sm:inline">Админ-панель</span>
              </Link>
            )}

            {(user.role === 'Admin' || user.role === 'Team-Lead') && (
              <Link
                href="/moderation"
                title="Модерация"
                className="flex items-center gap-1.5 rounded-md border border-line/10 px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink sm:px-2.5"
              >
                <Globe size={12} />
                <span className="hidden sm:inline">Модерация</span>
              </Link>
            )}

            {activePageId && isOwnDocument && (
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                title="Поделиться"
                className="flex items-center gap-1.5 rounded-md border border-line/10 px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink sm:px-2.5"
              >
                <Share2 size={12} />
                <span className="hidden sm:inline">Поделиться</span>
              </button>
            )}

            {activePageId && !doc.isLoading && (
              <button
                type="button"
                onClick={() => setSidebarOpen((v) => !v)}
                title={sidebarOpen ? 'Скрыть боковую панель' : 'Показать боковую панель'}
                className={`rounded-md border border-line/10 p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink ${
                  sidebarOpen ? 'bg-surface-hover text-ink' : ''
                }`}
              >
                <PanelRight size={14} />
              </button>
            )}

            <Link href="/settings" title="Настройки профиля" className="rounded-full hover:opacity-80">
              <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="sm" />
            </Link>

            <ThemeToggle />

            <button
              type="button"
              onClick={() => logout()}
              title="Выйти"
              className="rounded-md border border-line/10 p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink"
            >
              <LogOut size={13} />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex-1 overflow-y-auto">
            {!activePageId ? (
              <EmptyState onCreate={() => handleCreatePage(null)} />
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
                onOpenPageRef={openPage}
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
      <span className="flex items-center gap-1.5">
        <Loader2 size={12} className="animate-spin" /> Сохранение...
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="flex items-center gap-1.5">
        <Cloud size={12} /> Сохранено
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-red-500">
        <CloudOff size={12} /> Ошибка сохранения
      </span>
    );
  }
  return null;
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-muted">
      <p>Выберите страницу слева (свою или расшаренную) или создайте новую</p>
      <button type="button" onClick={onCreate} className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90">
        Создать страницу
      </button>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (user: CurrentUser, token: string) => void }) {
  const { settings } = useSiteSettings();
  const logoSrc = logoUrlWithCacheBust(settings, 'login');
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

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-surface">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-xl border border-line/10 bg-surface-panel p-6 shadow-panel">
        {logoSrc && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoSrc}
            alt={settings.siteName}
            style={{ height: LOGIN_LOGO_HEIGHT }}
            className="mx-auto mb-3 block max-w-[220px] object-contain"
          />
        )}
        <h1 className="mb-1 text-lg font-semibold text-ink">Вход в {settings.siteName}</h1>
        <p className="mb-5 text-sm text-ink-muted">Самостоятельная регистрация недоступна — обратитесь к администратору за приглашением.</p>
        <div className="space-y-3">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-line/10 bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <input
            type="password"
            required
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-line/10 bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-accent py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {isSubmitting && <Loader2 size={14} className="animate-spin" />}
          Войти
        </button>
      </form>
      {settings.copyrightText && <p className="mt-4 text-xs text-ink-faint">{settings.copyrightText}</p>}
      {settings.version && <p className="mt-1 text-[11px] text-ink-faint">v{settings.version}</p>}
    </div>
  );
}
