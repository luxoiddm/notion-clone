'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { Loader2, LogIn, ChevronLeft } from 'lucide-react';
import { WorkspaceBrand, PrimaryNav, UserMenu } from './AppNav';
import { MobileTabBar, MobileFab } from './MobileTabBar';

/**
 * Каркас второстепенных разделов (сообщения, файлы, доступные мне,
 * настройки, админка, модерация): постоянный сайдбар навигации слева
 * и область контента с заголовком раздела. На телефоне сайдбара нет —
 * вместо него нижняя панель вкладок (MobileTabBar), крупный заголовок
 * раздела, «Назад» для разделов из «Ещё» и плавающая кнопка действия. Главная (`app/page.tsx`) использует свой Sidebar с деревом
 * страниц, но те же PrimaryNav/UserMenu — так навигация одинакова везде.
 */
export function AppShell({
  children,
  title,
  description,
  icon,
  actions,
  width = 'default',
  flush = false,
  hideMobileBar = false,
  mobileBack,
  fab,
}: {
  children: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  /** Максимальная ширина колонки контента. */
  width?: 'narrow' | 'default' | 'wide';
  /** Без отступов и заголовка — контент сам занимает всю область (чат). */
  flush?: boolean;
  /** Телефон: спрятать нижнюю панель вкладок (у контента своя шапка с «Назад» — например, открытый чат). */
  hideMobileBar?: boolean;
  /** Телефон: строка «Назад» над заголовком (разделы, открытые из «Ещё»). */
  mobileBack?: { href: string; label: string };
  /** Телефон: плавающая кнопка главного действия; кнопки `actions` в шапке тогда скрыты. */
  fab?: { icon: React.ReactNode; label: string; onClick: () => void; extended?: boolean };
}) {
  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-surface">
      <aside className="hidden w-[260px] shrink-0 flex-col border-r border-line/[0.07] bg-surface-panel md:flex">
        <div className="flex min-h-[56px] items-center justify-between gap-2 px-2.5 py-1.5">
          <WorkspaceBrand />
        </div>
        <div className="px-2.5 pt-1">
          <PrimaryNav />
        </div>
        <div className="flex-1" />
        <div className="border-t border-line/[0.06] p-2">
          <UserMenu />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Телефон: «Назад» для разделов из вкладки «Ещё» */}
        {mobileBack && !hideMobileBar && (
          <div className="flex h-12 shrink-0 items-center px-1 md:hidden">
            <Link href={mobileBack.href} className="flex h-11 items-center gap-0.5 rounded-lg pl-1 pr-3 text-[15px] text-ink-muted active:bg-surface-hover">
              <ChevronLeft size={22} />
              {mobileBack.label}
            </Link>
          </div>
        )}

        {flush ? (
          <div className={clsx('flex min-h-0 flex-1', !hideMobileBar && 'pb-[calc(var(--tabbar-h)+var(--safe-bottom))] md:pb-0')}>{children}</div>
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div
              className={clsx(
                'pb-tabbar mx-auto px-4 pb-16 sm:px-8 md:pt-12',
                mobileBack ? 'pt-1' : 'pt-5',
                width === 'narrow' && 'max-w-2xl',
                width === 'default' && 'max-w-4xl',
                width === 'wide' && 'max-w-6xl',
              )}
            >
              {(title || actions) && (
                <header className="mb-6 flex flex-wrap items-end justify-between gap-4 md:mb-8">
                  <div className="flex min-w-0 items-start gap-3.5">
                    {icon && (
                      <span className="mt-0.5 hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line/[0.08] bg-surface-raised text-accent shadow-xs md:flex">
                        {icon}
                      </span>
                    )}
                    <div className="min-w-0">
                      {title && <h1 className="page-title max-md:text-[30px] max-md:font-bold max-md:leading-tight">{title}</h1>}
                      {description && <p className="page-subtitle max-md:hidden">{description}</p>}
                    </div>
                  </div>
                  {actions && <div className={clsx('shrink-0 items-center gap-2', fab ? 'hidden md:flex' : 'flex')}>{actions}</div>}
                </header>
              )}
              {children}
            </div>
          </main>
        )}
      </div>

      {!hideMobileBar && <MobileTabBar />}
      {fab && !hideMobileBar && <MobileFab {...fab} />}
    </div>
  );
}

export function FullScreenLoader() {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-surface text-ink-faint">
      <Loader2 size={20} className="animate-spin" />
    </div>
  );
}

export function SignInRequired({ message = 'Нужно сначала войти в рабочее пространство.' }: { message?: string }) {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-surface p-6">
      <div className="card flex max-w-sm flex-col items-center gap-4 p-8 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          <LogIn size={20} />
        </span>
        <p className="text-sm text-ink-muted">{message}</p>
        <Link href="/" className="btn-primary">
          На главную
        </Link>
      </div>
    </div>
  );
}

/** Пустое состояние списка/раздела. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center justify-center rounded-xl border border-dashed border-line/[0.12] px-6 py-14 text-center', className)}>
      {icon && <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-sunken text-ink-faint">{icon}</span>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
