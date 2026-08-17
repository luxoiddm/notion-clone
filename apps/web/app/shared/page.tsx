'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FileText, Users } from 'lucide-react';
import { api } from '../../lib/api';
import type { PageNode } from '../../lib/types';
import { useSession } from '../../components/SessionProvider';
import { PageIconDisplay } from '../../components/PageIconDisplay';
import { useUserStore } from '../../store/useUserStore';
import { SidebarSkeleton } from '../../components/Skeleton';

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
    return <div className="flex h-screen items-center justify-center text-ink-muted">Загрузка...</div>;
  }

  if (!user) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-ink-muted">
        <p>Нужно сначала войти в рабочее пространство.</p>
        <Link href="/" className="text-accent hover:underline">
          На главную
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-6 py-10 sm:px-10">
      <Link href="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft size={14} />
        Назад в рабочее пространство
      </Link>

      <h1 className="mb-1 flex items-center gap-2 text-2xl font-bold text-ink">
        <Users size={22} className="text-accent" />
        Расшаренные со мной
      </h1>
      <p className="mb-6 text-sm text-ink-muted">Документы, к которым другие пользователи открыли вам доступ.</p>

      {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

      {pages === null ? (
        <SidebarSkeleton />
      ) : pages.length === 0 ? (
        <p className="rounded-lg border border-line/10 bg-surface-panel p-6 text-center text-sm text-ink-muted">
          Пока ничего не расшарено с вами.
        </p>
      ) : (
        <ul className="space-y-1">
          {pages.map((page) => (
            <li key={`${page.ownerId}:${page.id}`}>
              <button
                type="button"
                onClick={() => openSharedPage(page)}
                className="flex w-full items-center gap-3 rounded-lg border border-line/10 bg-surface-panel px-4 py-3 text-left transition-colors hover:bg-surface-hover"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line/10 bg-surface text-lg">
                  <PageIconDisplay icon={page.icon} size={20} fallback={<FileText size={16} className="text-ink-faint" />} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{page.title || 'Untitled'}</span>
                  <span className="block truncate text-xs text-ink-muted">
                    от {users[page.ownerId] ?? page.ownerId} · обновлено {new Date(page.updatedAt).toLocaleDateString('ru-RU')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
