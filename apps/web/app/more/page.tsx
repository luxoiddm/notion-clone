'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { useTheme } from 'next-themes';
import { ChevronRight, Users, Globe, ShieldCheck, Settings, Bell, LogOut, Sun, Moon, Monitor } from 'lucide-react';
import { useSession } from '../../components/SessionProvider';
import { useSiteSettings } from '../../components/SiteSettingsProvider';
import { AppShell, FullScreenLoader, SignInRequired } from '../../components/AppShell';
import { Avatar } from '../../components/Avatar';
import { getSoundSettings, onSoundSettingsChange, setSoundSettings, unlockAudio } from '../../lib/sounds';

const ROLE_LABEL: Record<string, string> = { Admin: 'Администратор', 'Team-Lead': 'Тимлид', Member: 'Участник', Guest: 'Гость' };

function Row({ href, icon, color, label, hint }: { href: string; icon: React.ReactNode; color: string; label: string; hint?: string }) {
  return (
    <Link href={href} className="flex min-h-[54px] items-center gap-3.5 border-b border-line/[0.06] px-3.5 last:border-b-0 active:bg-surface-hover">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-white" style={{ background: color }}>
        {icon}
      </span>
      <span className="flex-1 text-[16px] text-ink">{label}</span>
      {hint && <span className="text-sm text-ink-muted">{hint}</span>}
      <ChevronRight size={18} className="text-ink-faint" />
    </Link>
  );
}

/**
 * Вкладка «Ещё» мобильной версии: профиль, редкие разделы (доступные мне,
 * публикация, администрирование), тема, звуки и выход. На компьютере те же
 * пункты есть в сайдбаре и меню пользователя — страница просто тоже работает.
 */
export default function MorePage() {
  const { user, isLoading, logout } = useSession();
  const { settings } = useSiteSettings();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [sound, setSound] = useState(true);

  useEffect(() => {
    setMounted(true);
    setSound(getSoundSettings().enabled);
    return onSoundSettingsChange((s) => setSound(s.enabled));
  }, []);

  if (isLoading) return <FullScreenLoader />;
  if (!user) return <SignInRequired />;

  const canModerate = user.role === 'Admin' || user.role === 'Team-Lead';

  return (
    <AppShell title="Ещё" width="narrow">
      <div className="space-y-5">
        <Link href="/settings" className="card flex items-center gap-3.5 p-3.5 active:bg-surface-hover">
          <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="lg" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[17px] font-semibold text-ink">{user.displayName}</span>
            <span className="block text-sm text-ink-muted">{ROLE_LABEL[user.role] ?? user.role}</span>
          </span>
          <ChevronRight size={18} className="text-ink-faint" />
        </Link>

        <div className="card overflow-hidden">
          <Row href="/shared" icon={<Users size={17} />} color="#0284C7" label="Доступные мне" />
          {canModerate && <Row href="/moderation" icon={<Globe size={17} />} color="#15803D" label="Публикация" />}
          {user.role === 'Admin' && <Row href="/admin" icon={<ShieldCheck size={17} />} color="#3F3F46" label="Администрирование" />}
        </div>

        <div className="card overflow-hidden">
          <div className="flex min-h-[54px] items-center gap-3.5 border-b border-line/[0.06] px-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[#7C3AED] text-white">
              <Moon size={17} />
            </span>
            <span className="flex-1 text-[16px] text-ink">Тема</span>
            {mounted && (
              <div className="segmented" role="radiogroup" aria-label="Тема">
                {(
                  [
                    ['light', Sun, 'Светлая'],
                    ['system', Monitor, 'Авто'],
                    ['dark', Moon, 'Тёмная'],
                  ] as const
                ).map(([value, Icon, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={theme === value}
                    aria-label={label}
                    onClick={() => setTheme(value)}
                    className={clsx('segmented-item h-8 px-2.5', theme === value && 'segmented-item-active')}
                  >
                    <Icon size={15} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex min-h-[54px] items-center gap-3.5 border-b border-line/[0.06] px-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[#EA580C] text-white">
              <Bell size={17} />
            </span>
            <span className="flex-1 text-[16px] text-ink">Звуки</span>
            <button
              type="button"
              role="switch"
              aria-checked={sound}
              aria-label="Звуки"
              onClick={() => {
                unlockAudio();
                setSoundSettings({ enabled: !sound });
              }}
              className={clsx('relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors', sound ? 'bg-accent' : 'bg-ink/15')}
            >
              <span className={clsx('absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-[left]', sound ? 'left-[22px]' : 'left-[2px]')} />
            </button>
          </div>
          <Row href="/settings" icon={<Settings size={17} />} color="#71717A" label="Настройки" />
        </div>

        <div className="card overflow-hidden">
          <button type="button" onClick={() => void logout().then(() => router.push('/'))} className="flex min-h-[54px] w-full items-center justify-center gap-2 text-[16px] text-danger active:bg-surface-hover">
            <LogOut size={17} />
            Выйти
          </button>
        </div>

        <p className="text-center text-xs text-ink-faint">
          {settings.copyrightText}
          {settings.copyrightText && settings.version && ' · '}
          {settings.version && `v${settings.version}`}
        </p>
      </div>
    </AppShell>
  );
}
