'use client';

import { useEffect, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { siteApi } from '../lib/api';
import { useSiteSettings, logoUrlWithCacheBust } from './SiteSettingsProvider';
import { useToast } from './Toast';

function LogoUploader({ kind, label, hint }: { kind: 'login' | 'header'; label: string; hint: string }) {
  const { settings, refresh } = useSiteSettings();
  const { push } = useToast();
  const [isUploading, setIsUploading] = useState(false);
  const logoSrc = logoUrlWithCacheBust(settings, kind);

  const handleChange = async (file: File) => {
    setIsUploading(true);
    try {
      await siteApi.uploadLogo(kind, file);
      refresh();
      push(`${label} обновлён`, 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : `Не удалось загрузить ${label.toLowerCase()}`, 'error');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-line/10 bg-surface">
        {logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoSrc} alt={label} className="max-h-12 max-w-12 object-contain" />
        ) : (
          <span className="text-xs text-ink-faint">Нет</span>
        )}
      </div>
      <div>
        <label className="flex w-fit cursor-pointer items-center gap-2 rounded-md border border-line/10 px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink">
          {isUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
          {label}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleChange(file);
              e.target.value = '';
            }}
          />
        </label>
        <p className="mt-1 text-xs text-ink-faint">{hint}</p>
      </div>
    </div>
  );
}

export function SiteSettingsForm() {
  const { settings, refresh } = useSiteSettings();
  const { push } = useToast();

  const [siteName, setSiteName] = useState(settings.siteName);
  const [siteDescription, setSiteDescription] = useState(settings.siteDescription);
  const [copyrightText, setCopyrightText] = useState(settings.copyrightText);
  const [isSaving, setIsSaving] = useState(false);

  // Re-seeds the drafts whenever the provider's own settings change (e.g.
  // they finished loading after this form already mounted, or a save
  // round-trip completed) — scoped to exactly these three fields, so a
  // logo-only refresh (which doesn't touch them) never disrupts whatever
  // the admin is mid-typing in a text field.
  useEffect(() => {
    setSiteName(settings.siteName);
    setSiteDescription(settings.siteDescription);
    setCopyrightText(settings.copyrightText);
  }, [settings.siteName, settings.siteDescription, settings.copyrightText]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await siteApi.updateSettings({ siteName, siteDescription, copyrightText });
      refresh();
      push('Настройки сайта сохранены', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось сохранить настройки', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="mb-8 rounded-lg border border-line/10 p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Настройки сайта</h2>
        {settings.version && <span className="text-xs text-ink-faint">v{settings.version}</span>}
      </div>
      <p className="mb-4 text-xs text-ink-muted">
        Название, описание и логотипы видны всем, включая экран входа — ещё до авторизации.
      </p>

      <div className="mb-5 space-y-4">
        <LogoUploader kind="login" label="Логотип экрана входа" hint="Крупный — показывается один раз, на весь экран логина." />
        <LogoUploader kind="header" label="Логотип в шапке" hint="Маленький — отдельное изображение, не тот же логотип уменьшенный." />
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">Название сайта</label>
          <input
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            className="w-full rounded-md border border-line/10 bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">Описание</label>
          <textarea
            value={siteDescription}
            onChange={(e) => setSiteDescription(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-md border border-line/10 bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">Копирайт (футер экрана входа и настроек профиля)</label>
          <input
            value={copyrightText}
            onChange={(e) => setCopyrightText(e.target.value)}
            placeholder="© 2026 Моя компания"
            className="w-full rounded-md border border-line/10 bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={isSaving}
        className="mt-4 flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
      >
        {isSaving && <Loader2 size={13} className="animate-spin" />}
        Сохранить
      </button>
    </section>
  );
}
