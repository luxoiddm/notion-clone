'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { FileText, MessageSquare, FolderOpen, MoreHorizontal } from 'lucide-react';
import { getUnread, onUnreadChange, totalUnread } from '../lib/unread';

const TABS = [
  { href: '/', label: 'Документы', icon: FileText, match: (p: string) => p === '/' },
  { href: '/chat', label: 'Чаты', icon: MessageSquare, match: (p: string) => p.startsWith('/chat') },
  { href: '/files', label: 'Файлы', icon: FolderOpen, match: (p: string) => p.startsWith('/files') },
  {
    href: '/more',
    label: 'Ещё',
    icon: MoreHorizontal,
    match: (p: string) => ['/more', '/shared', '/moderation', '/admin', '/settings'].some((x) => p.startsWith(x)),
  },
] as const;

export function useUnreadTotal(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(totalUnread(getUnread()));
    return onUnreadChange((c) => setN(totalUnread(c)));
  }, []);
  return n;
}

/**
 * Нижняя панель вкладок — главная навигация на телефоне (вариант A
 * мобильного дизайна): основные разделы под большим пальцем, редкие —
 * во вкладке «Ещё». На экранах от 768px не показывается: там сайдбар.
 */
export function MobileTabBar() {
  const pathname = usePathname() ?? '/';
  const unread = useUnreadTotal();

  return (
    <nav
      aria-label="Разделы"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line/[0.08] bg-surface/95 px-1 backdrop-blur-md md:hidden"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      {TABS.map(({ href, label, icon: Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
              active ? 'text-accent' : 'text-ink-muted',
            )}
          >
            <Icon size={22} strokeWidth={active ? 2.1 : 1.8} />
            {label}
            {href === '/chat' && unread > 0 && (
              <span className="absolute left-1/2 top-1.5 ml-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[11px] font-semibold leading-none text-white">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** Плавающая кнопка главного действия раздела (над нижней панелью), только на телефоне. */
export function MobileFab({ icon, label, onClick, extended = false }: { icon: React.ReactNode; label: string; onClick: () => void; extended?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={clsx(
        'fixed right-4 z-30 flex h-14 items-center justify-center gap-2 rounded-2xl bg-accent font-semibold text-white shadow-[0_8px_24px_rgb(var(--accent)/0.35)] transition-transform active:scale-95 md:hidden',
        extended ? 'px-5' : 'w-14',
      )}
      style={{ bottom: 'calc(var(--tabbar-h) + var(--safe-bottom) + 16px)' }}
    >
      {icon}
      {extended && <span className="text-[15px]">{label}</span>}
    </button>
  );
}
