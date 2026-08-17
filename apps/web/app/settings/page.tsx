'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Check } from 'lucide-react';
import { useSession } from '../../components/SessionProvider';
import { api, type UserFileInfo } from '../../lib/api';
import { FilePickerDialog } from '../../components/FilePickerDialog';
import { Avatar } from '../../components/Avatar';
import { ACCENT_PRESETS } from '../../lib/accentPalette';
import { useSiteSettings } from '../../components/SiteSettingsProvider';
import { ToastProvider, useToast } from '../../components/Toast';

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
    return (
      <div className="flex h-screen items-center justify-center text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
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

  const activeColorKey = user.accentColor ?? 'slate';

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <Link href="/" className="mb-6 flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft size={14} />
        На главную
      </Link>

      <h1 className="mb-6 text-lg font-semibold text-ink">Настройки профиля</h1>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-ink">Аватар</h2>
        <div className="flex items-center gap-4">
          <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="xl" />
          <div>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              disabled={isSavingAvatar}
              className="flex items-center gap-2 rounded-md border border-line/10 px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-60"
            >
              {isSavingAvatar && <Loader2 size={13} className="animate-spin" />}
              Изменить аватар
            </button>
            <p className="mt-1.5 text-xs text-ink-faint">
              Можно выбрать уже загруженный файл или загрузить новый — картинка обрежется под квадрат и уменьшится
              автоматически.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-ink">Акцентный цвет</h2>
        <p className="mb-3 text-xs text-ink-faint">Красит кнопки, ссылки и свои сообщения в чате по всему приложению.</p>
        <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
          {ACCENT_PRESETS.map((preset) => {
            const isActive = activeColorKey === preset.key;
            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => void handlePickColor(preset.key)}
                title={preset.label}
                className="flex flex-col items-center gap-1.5"
              >
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-full border-2 transition-transform hover:scale-105"
                  style={{
                    backgroundColor: `rgb(${preset.light.accent})`,
                    borderColor: isActive ? `rgb(${preset.light.accent})` : 'transparent',
                  }}
                >
                  {savingColorKey === preset.key ? (
                    <Loader2 size={14} className="animate-spin text-white" />
                  ) : isActive ? (
                    <Check size={14} className="text-white" />
                  ) : null}
                </span>
                <span className="text-[11px] text-ink-muted">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {pickerOpen && <FilePickerDialog onClose={() => setPickerOpen(false)} onPick={(f) => void handlePickAvatar(f)} imagesOnly />}

      {settings.copyrightText && <p className="mt-10 text-center text-xs text-ink-faint">{settings.copyrightText}</p>}
      {settings.version && <p className="mt-1 text-center text-[11px] text-ink-faint">v{settings.version}</p>}
    </div>
  );
}
