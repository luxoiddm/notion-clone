'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { FileText, MessageSquare, FolderOpen, Users, Globe, ShieldCheck, Settings, LogOut, ChevronsUpDown, Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSession } from './SessionProvider';
import { Avatar } from './Avatar';
import { useSiteSettings, logoUrlWithCacheBust, HEADER_LOGO_HEIGHT, SiteLogo } from './SiteSettingsProvider';

/**
 * Общие элементы навигации приложения — используются и в сайдбаре главной
 * (вместе с деревом страниц), и в AppShell второстепенных разделов
 * (чат, файлы, настройки, админка), чтобы навигация была одной и той же
 * на любом экране, а не россыпью кнопок в шапке плюс «Назад» на каждой
 * отдельной странице.
 */

const ROLE_LABEL: Record<string, string> = {
  Admin: 'Администратор',
  'Team-Lead': 'Тимлид',
  Member: 'Участник',
  Guest: 'Гость',
};

/** Логотип + название сайта — верхняя строка любого сайдбара. */
export function WorkspaceBrand() {
  const { settings } = useSiteSettings();
  const logoSrc = logoUrlWithCacheBust(settings, 'header');
  const initial = settings.siteName.trim().slice(0, 1).toUpperCase() || 'W';

  // Если загружен логотип — показываем только его, крупно (высота из
  // NEXT_PUBLIC_HEADER_LOGO_HEIGHT, по умолчанию 32px): в логотипе обычно
  // уже есть название, дублировать его текстом рядом незачем.
  if (logoSrc) {
    return (
      <Link href="/" title={settings.siteName} className="flex min-w-0 items-center rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-hover">
        <SiteLogo settings={settings} kind="header" style={{ height: Math.max(HEADER_LOGO_HEIGHT, 40) }} className="max-w-[200px] object-contain object-left" />
      </Link>
    );
  }

  return (
    <Link href="/" className="flex min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-hover">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent/70 text-sm font-bold text-white shadow-xs">
        {initial}
      </span>
      <span className="truncate text-sm font-semibold tracking-[-0.01em] text-ink">{settings.siteName}</span>
    </Link>
  );
}

interface NavLink {
  href: string;
  label: string;
  icon: typeof FileText;
  match: (path: string) => boolean;
  visible?: (role: string) => boolean;
}

const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Документы', icon: FileText, match: (p) => p === '/' },
  { href: '/chat', label: 'Сообщения', icon: MessageSquare, match: (p) => p.startsWith('/chat') },
  { href: '/files', label: 'Файлы', icon: FolderOpen, match: (p) => p.startsWith('/files') },
  { href: '/shared', label: 'Доступные мне', icon: Users, match: (p) => p.startsWith('/shared') },
  {
    href: '/moderation',
    label: 'Публикация',
    icon: Globe,
    match: (p) => p.startsWith('/moderation'),
    visible: (role) => role === 'Admin' || role === 'Team-Lead',
  },
  { href: '/admin', label: 'Администрирование', icon: ShieldCheck, match: (p) => p.startsWith('/admin'), visible: (role) => role === 'Admin' },
];

/** Основные разделы приложения. `onNavigate` — закрыть мобильный drawer после перехода. */
export function PrimaryNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? '/';
  const { user } = useSession();
  const role = user?.role ?? 'Guest';

  return (
    <nav className="space-y-px">
      {NAV_LINKS.filter((l) => !l.visible || l.visible(role)).map(({ href, label, icon: Icon, match }) => {
        const active = match(pathname);
        return (
          <Link key={href} href={href} onClick={onNavigate} className={clsx('nav-item', active && 'nav-item-active')}>
            <Icon size={16} strokeWidth={active ? 2.1 : 1.8} className={clsx('shrink-0', active ? 'text-accent' : 'text-ink-faint')} />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

const THEME_OPTIONS = [
  { value: 'light', icon: Sun, label: 'Светлая' },
  { value: 'system', icon: Monitor, label: 'Авто' },
  { value: 'dark', icon: Moon, label: 'Тёмная' },
] as const;

/** Карточка текущего пользователя внизу сайдбара + меню: профиль, тема, выход. */
export function UserMenu() {
  const { user, logout } = useSession();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div ref={ref} className="relative">
      {open && (
        <div className="popover absolute bottom-full left-0 right-0 z-50 mb-1.5">
          <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
            <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="md" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{user.displayName}</p>
              <p className="truncate text-xs text-ink-muted">{ROLE_LABEL[user.role] ?? user.role}</p>
            </div>
          </div>
          <div className="my-1 h-px bg-line/[0.07]" />
          <Link href="/settings" onClick={() => setOpen(false)} className="menu-item">
            <Settings size={15} className="text-ink-muted" />
            Настройки профиля
          </Link>
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="text-sm text-ink">Тема</span>
            {mounted && (
              <div className="segmented">
                {THEME_OPTIONS.map(({ value, icon: Icon, label }) => (
                  <button
                    key={value}
                    type="button"
                    title={label}
                    aria-label={label}
                    onClick={() => setTheme(value)}
                    className={clsx('segmented-item h-6 px-1.5', theme === value && 'segmented-item-active')}
                  >
                    <Icon size={13} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="my-1 h-px bg-line/[0.07]" />
          <button type="button" onClick={() => void logout()} className="menu-item text-ink-muted hover:text-danger">
            <LogOut size={15} />
            Выйти
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-hover',
          open && 'bg-surface-hover',
        )}
      >
        <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-5 text-ink">{user.displayName}</p>
          <p className="truncate text-2xs text-ink-faint">{ROLE_LABEL[user.role] ?? user.role}</p>
        </div>
        <ChevronsUpDown size={14} className="shrink-0 text-ink-faint" />
      </button>
    </div>
  );
}
