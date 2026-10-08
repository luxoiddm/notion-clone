'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Users } from 'lucide-react';
import { api } from '../../lib/api';
import type { PageNode } from '../../lib/types';
import { useSession } from '../../components/SessionProvider';
import { PageIconDisplay } from '../../components/PageIconDisplay';
import { useUserStore } from '../../store/useUserStore';
import { SidebarSkeleton } from '../../components/Skeleton';
import { AppShell, EmptyState, FullScreenLoader, SignInRequired } from '../../components/AppShell';
import { Avatar } from '../../components/Avatar';

export default function SharedPage() {
  const { user, isLoading: sessionLoading } = useSession();
  const { openPage } = useUserStore();
  const router = useRouter();
  const [pages, setPages] = useState<PageNode[] | null>(null);
  const [users, setUsers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Reuses the session already restored by SessionProvider in this tab;
    // if there's genuinely no session, the check below sends the person
    // back to `/` to log in.
    if (!user) return;

    Promise.all([api.listShared(), api.listUsersDirectory()])
      .then(([shared, directory]) => {
        setPages(shared);
        setUsers(Object.fromEntries(directory.map((u) => [u.id, u.displayName])));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить список'));
  }, [user]);

  const openSharedPage = (page: PageNode) => {
    // Opens the document inside the main workspace (same editor, same
    // presence/sharing logic as any own page) instead of a separate
    // read-only viewer route — one place that knows how to render a page,
    // whether it's yours or someone else's.
    openPage(page.ownerId, page.projectId, page.id);
    router.push('/');
  };

  if (sessionLoading) {
    return <FullScreenLoader />;
  }

  if (!user) {
    return <SignInRequired />;
  }

  const levelLabel = (page: PageNode): string => {
    const grant = page.sharing.find((g) => g.userId === user.id) ?? page.sharing.find((g) => g.userId === '*');
    switch (grant?.level) {
      case 'admin':
        return 'Полный доступ';
      case 'edit':
        return 'Редактирование';
      case 'comment':
        return 'Комментирование';
      default:
        return 'Чтение';
    }
  };

  return (
    <AppShell mobileBack={{ href: '/more', label: 'Ещё' }} title="Доступные мне" icon={<Users size={19} />} description="Документы, к которым коллеги открыли вам доступ.">
      {error && <p className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      {pages === null ? (
        <SidebarSkeleton />
      ) : pages.length === 0 ? (
        <EmptyState
          icon={<Users size={20} />}
          title="Пока ничего нет"
          description="Когда коллега поделится с вами страницей, она появится здесь и в сайдбаре."
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="hidden grid-cols-[1fr_180px_140px_110px] gap-4 border-b border-line/[0.06] bg-surface-panel px-4 py-2 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-faint sm:grid">
            <span>Документ</span>
            <span>Владелец</span>
            <span>Доступ</span>
            <span className="text-right">Изменён</span>
          </div>
          <ul className="divide-y divide-line/[0.06]">
            {pages.map((page) => {
              const owner = users[page.ownerId] ?? page.ownerId;
              return (
                <li key={`${page.ownerId}:${page.id}`}>
                  <button
                    type="button"
                    onClick={() => openSharedPage(page)}
                    className="grid w-full grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-surface-hover sm:grid-cols-[1fr_180px_140px_110px]"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-base">
                        <PageIconDisplay icon={page.icon} size={18} fallback={<FileText size={15} className="text-ink-faint" />} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">{page.title || 'Без названия'}</span>
                        <span className="block truncate text-xs text-ink-faint sm:hidden">{owner}</span>
                      </span>
                    </span>
                    <span className="hidden min-w-0 items-center gap-2 sm:flex">
                      <Avatar avatarUrl={null} displayName={owner} size="xs" />
                      <span className="truncate text-sm text-ink-muted">{owner}</span>
                    </span>
                    <span className="hidden sm:block">
                      <span className="badge">{levelLabel(page)}</span>
                    </span>
                    <span className="text-right text-xs tabular-nums text-ink-faint">
                      {new Date(page.updatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </AppShell>
  );
}
