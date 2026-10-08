'use client';

import { useEffect, useState } from 'react';
import { Loader2, Check, Camera, Settings, Sun, Moon, Monitor } from 'lucide-react';
import { useSession } from '../../components/SessionProvider';
import { api, type UserFileInfo } from '../../lib/api';
import { FilePickerDialog } from '../../components/FilePickerDialog';
import { Avatar } from '../../components/Avatar';
import { ACCENT_PRESETS } from '../../lib/accentPalette';
import { useSiteSettings } from '../../components/SiteSettingsProvider';
import { ToastProvider, useToast } from '../../components/Toast';
import { AppShell, FullScreenLoader, SignInRequired } from '../../components/AppShell';
import { useTheme } from 'next-themes';
import { SoundSettingsCard } from '../../components/SoundSettingsCard';

export default function SettingsPage() {
  return (
    <ToastProvider>
      <SettingsPageContent />
    </ToastProvider>
  );
}

function SettingsPageContent() {
  const { user, isLoading: sessionLoading, updateUser } = useSession();
  const { settings } = useSiteSettings();
  const { push } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isSavingAvatar, setIsSavingAvatar] = useState(false);
  const [savingColorKey, setSavingColorKey] = useState<string | null>(null);

  if (sessionLoading) {
    return <FullScreenLoader />;
  }

  if (!user) {
    return <SignInRequired />;
  }

  const handlePickAvatar = async (file: UserFileInfo) => {
    setPickerOpen(false);
    setIsSavingAvatar(true);
    try {
      const updated = await api.setOwnAvatar(file.fileName);
      updateUser({ avatarUrl: updated.avatarUrl });
      push('Аватар обновлён', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось обновить аватар', 'error');
    } finally {
      setIsSavingAvatar(false);
    }
  };

  const handlePickColor = async (key: string) => {
    setSavingColorKey(key);
    try {
      const updated = await api.updateOwnAccentColor(key);
      updateUser({ accentColor: updated.accentColor });
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось изменить цвет', 'error');
    } finally {
      setSavingColorKey(null);
    }
  };

  const activeColorKey = user.accentColor ?? 'indigo';

  return (
    <AppShell mobileBack={{ href: '/more', label: 'Ещё' }} title="Настройки" icon={<Settings size={19} />} description="Профиль и оформление интерфейса — видны только вам." width="narrow">
      <div className="space-y-6">
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Профиль</h2>
              <p className="card-desc">Как вас видят коллеги в чатах, комментариях и на страницах.</p>
            </div>
          </div>
          <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
            <div className="relative w-fit">
              <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="xl" className="ring-4 ring-surface-raised" />
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                disabled={isSavingAvatar}
                title="Изменить аватар"
                className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full border border-line/10 bg-surface-raised text-ink-muted shadow-pop transition-colors hover:text-ink"
              >
                {isSavingAvatar ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
              </button>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-ink">{user.displayName}</p>
              <p className="mt-0.5 text-sm text-ink-muted">{ROLE_LABEL[user.role] ?? user.role}</p>
              <button type="button" onClick={() => setPickerOpen(true)} disabled={isSavingAvatar} className="btn-secondary btn-sm mt-3">
                Загрузить фото
              </button>
              <p className="hint">Картинка обрежется под квадрат и уменьшится автоматически.</p>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Оформление</h2>
              <p className="card-desc">Тема и акцентный цвет применяются сразу, без перезагрузки.</p>
            </div>
          </div>
          <div className="space-y-6 p-5">
            <div>
              <p className="label">Тема</p>
              <ThemePicker />
            </div>
            <div>
              <p className="label">Акцентный цвет</p>
              <div className="flex flex-wrap gap-2.5">
                {ACCENT_PRESETS.map((preset) => {
                  const isActive = activeColorKey === preset.key;
                  return (
                    <button
                      key={preset.key}
                      type="button"
                      onClick={() => void handlePickColor(preset.key)}
                      title={preset.label}
                      aria-label={preset.label}
                      className="group flex flex-col items-center gap-1.5"
                    >
                      <span
                        className="flex h-9 w-9 items-center justify-center rounded-full shadow-xs ring-offset-2 ring-offset-surface-raised transition-transform group-hover:scale-110"
                        style={{
                          backgroundColor: `rgb(${preset.light.accent})`,
                          boxShadow: isActive ? `0 0 0 2px rgb(var(--surface-raised)), 0 0 0 4px rgb(${preset.light.accent})` : undefined,
                        }}
                      >
                        {savingColorKey === preset.key ? (
                          <Loader2 size={14} className="animate-spin text-white" />
                        ) : isActive ? (
                          <Check size={15} strokeWidth={2.5} className="text-white" />
                        ) : null}
                      </span>
                      <span className={`text-2xs ${isActive ? 'font-medium text-ink' : 'text-ink-faint'}`}>{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <SoundSettingsCard />

        {(settings.copyrightText || settings.version) && (
          <p className="pt-2 text-center text-xs text-ink-faint">
            {settings.copyrightText}
            {settings.copyrightText && settings.version && ' · '}
            {settings.version && `v${settings.version}`}
          </p>
        )}
      </div>

      {pickerOpen && <FilePickerDialog onClose={() => setPickerOpen(false)} onPick={(f) => void handlePickAvatar(f)} imagesOnly />}
    </AppShell>
  );
}

const ROLE_LABEL: Record<string, string> = {
  Admin: 'Администратор',
  'Team-Lead': 'Тимлид',
  Member: 'Участник',
  Guest: 'Гость',
};

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const options = [
    { value: 'light', label: 'Светлая', icon: Sun },
    { value: 'dark', label: 'Тёмная', icon: Moon },
    { value: 'system', label: 'Как в системе', icon: Monitor },
  ] as const;

  return (
    <div className="grid grid-cols-3 gap-3">
      {options.map(({ value, label, icon: Icon }) => {
        const active = mounted && theme === value;
        const preview = (dark: boolean) => (
          <span className={`flex h-full w-full gap-1 p-1.5 ${dark ? 'bg-[#161619]' : 'bg-[#fafaf9]'}`}>
            <span className={`w-1/3 space-y-1 rounded-sm p-1 ${dark ? 'bg-[#1c1c20]' : 'bg-white'}`}>
              <span className={`block h-1 w-3/4 rounded-full ${dark ? 'bg-white/20' : 'bg-black/10'}`} />
              <span className="block h-1 w-1/2 rounded-full bg-accent/70" />
              <span className={`block h-1 w-2/3 rounded-full ${dark ? 'bg-white/20' : 'bg-black/10'}`} />
            </span>
            <span className={`flex-1 space-y-1 rounded-sm p-1 ${dark ? 'bg-[#1c1c20]' : 'bg-white'}`}>
              <span className={`block h-1.5 w-1/2 rounded-full ${dark ? 'bg-white/30' : 'bg-black/20'}`} />
              <span className={`block h-1 w-full rounded-full ${dark ? 'bg-white/10' : 'bg-black/[0.06]'}`} />
              <span className={`block h-1 w-5/6 rounded-full ${dark ? 'bg-white/10' : 'bg-black/[0.06]'}`} />
            </span>
          </span>
        );
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            className={`overflow-hidden rounded-lg border text-left transition-[border-color,box-shadow] ${
              active ? 'border-accent shadow-ring' : 'border-line/10 hover:border-line/20'
            }`}
          >
            <span className="flex h-16 overflow-hidden border-b border-line/[0.06]">
              {value === 'system' ? (
                <>
                  <span className="w-1/2 overflow-hidden">{preview(false)}</span>
                  <span className="w-1/2 overflow-hidden">{preview(true)}</span>
                </>
              ) : (
                preview(value === 'dark')
              )}
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-ink">
              <Icon size={13} className={active ? 'text-accent' : 'text-ink-faint'} />
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
