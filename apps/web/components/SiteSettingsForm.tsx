'use client';

import { useEffect, useState } from 'react';
import { Loader2, Upload, Image as ImageIcon, Trash2, Moon, Sun } from 'lucide-react';
import { siteApi, type SiteImageKind } from '../lib/api';
import { useSiteSettings, logoUrlWithCacheBust, SiteLogo } from './SiteSettingsProvider';
import type { DarkLogoMode } from '../lib/api';
import { useToast } from './Toast';

function LogoUploader({ kind, label, hint }: { kind: SiteImageKind; label: string; hint: string }) {
  const { settings, refresh } = useSiteSettings();
  const { push } = useToast();
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const src = logoUrlWithCacheBust(settings, kind);
  const isBackground = kind === 'login-bg';
  const isDarkVariant = kind === 'login-dark' || kind === 'header-dark';

  const handleChange = async (file: File) => {
    setBusy('upload');
    try {
      await siteApi.uploadLogo(kind, file);
      refresh();
      push(`${label}: обновлено`, 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : `Не удалось загрузить: ${label.toLowerCase()}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    const question = isBackground
      ? 'Убрать фон экрана входа?'
      : isDarkVariant
        ? `Убрать ${label.toLowerCase()}? В тёмной теме будет показан основной логотип.`
        : `Убрать ${label.toLowerCase()}? Вместо него будет показано название сайта.`;
    if (!confirm(question)) return;
    setBusy('remove');
    try {
      await siteApi.deleteLogo(kind);
      refresh();
      push(`${label}: убрано`, 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось убрать', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={isBackground ? 'flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4' : 'flex items-center gap-4'}>
      <div
        className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed ${
          // Превью на фоне «своей» темы: основные логотипы — на белом, тёмные версии — на тёмном.
          isDarkVariant ? 'border-white/15 bg-[#18181b]' : isBackground ? 'border-line/[0.14] bg-surface-sunken' : 'border-line/[0.14] bg-white'
        } ${
          isBackground ? 'aspect-video w-full sm:w-40' : 'h-14 w-14'
        }`}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={label} className={isBackground ? 'h-full w-full object-cover' : 'max-h-12 max-w-12 object-contain'} />
        ) : (
          <ImageIcon size={18} className="text-ink-faint" />
        )}
      </div>
      <div className="min-w-0">
        <p className="mb-1.5 text-sm font-medium text-ink">{label}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <label className={`btn-secondary btn-sm w-fit cursor-pointer ${busy ? 'pointer-events-none opacity-60' : ''}`}>
            {busy === 'upload' ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {src ? 'Заменить' : 'Загрузить'}
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
          {src && (
            <button type="button" onClick={() => void handleRemove()} disabled={!!busy} className="btn-ghost btn-sm hover:text-danger">
              {busy === 'remove' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              {isBackground ? 'Без фона' : isDarkVariant ? 'Убрать' : 'Без логотипа'}
            </button>
          )}
        </div>
        <p className="mt-1.5 text-xs text-ink-faint">{hint}</p>
      </div>
    </div>
  );
}

const DARK_MODES: { value: DarkLogoMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Авто', hint: 'Тёмные (чёрные, тёмно-серые) логотипы инвертируются, цветные и светлые остаются как есть.' },
  { value: 'invert', label: 'Инвертировать', hint: 'Логотип всегда инвертируется: чёрное становится белым, оттенки цветов сохраняются.' },
  { value: 'none', label: 'Как есть', hint: 'Логотип показывается без изменений.' },
];

/** Как логотипы выглядят в тёмной теме: режим для основного логотипа + отдельные тёмные версии. */
function DarkLogoSettings() {
  const { settings, refresh } = useSiteSettings();
  const { push } = useToast();
  const [saving, setSaving] = useState(false);
  const hasAnyLogo = !!(settings.loginLogoUrl || settings.headerLogoUrl);

  const setMode = async (mode: DarkLogoMode) => {
    if (mode === settings.darkLogoMode) return;
    setSaving(true);
    try {
      await siteApi.updateSettings({ darkLogoMode: mode });
      refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось сохранить', 'error');
    } finally {
      setSaving(false);
    }
  };

  const preview = (kind: 'login' | 'header', label: string) =>
    logoUrlWithCacheBust(settings, kind) && (
      <div className="min-w-0">
        <p className="mb-1.5 text-xs text-ink-muted">{label}</p>
        <div className="flex overflow-hidden rounded-lg border border-line/[0.1]">
          <div className="flex h-16 flex-1 items-center justify-center gap-2 bg-white px-3">
            <Sun size={12} className="shrink-0 text-zinc-400" />
            <SiteLogo settings={settings} kind={kind} forceTheme="light" className="max-h-10 min-w-0 max-w-[140px] object-contain" />
          </div>
          <div className="flex h-16 flex-1 items-center justify-center gap-2 bg-[#18181b] px-3">
            <Moon size={12} className="shrink-0 text-zinc-500" />
            <SiteLogo settings={settings} kind={kind} forceTheme="dark" className="max-h-10 min-w-0 max-w-[140px] object-contain" />
          </div>
        </div>
      </div>
    );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <Moon size={14} className="text-ink-faint" /> Логотипы в тёмной теме
          </p>
          <p className="mt-0.5 text-xs text-ink-faint">{DARK_MODES.find((m) => m.value === settings.darkLogoMode)?.hint}</p>
        </div>
        <div className="segmented">
          {DARK_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              disabled={saving}
              onClick={() => void setMode(m.value)}
              className={`segmented-item px-3 text-xs ${settings.darkLogoMode === m.value ? 'segmented-item-active' : ''}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {hasAnyLogo && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          {preview('login', 'Экран входа')}
          {preview('header', 'Сайдбар')}
        </div>
      )}
      <p className="mb-3 text-xs text-ink-muted">
        Можно загрузить отдельные версии для тёмной темы — тогда они используются вместо основных (режим выше на них не влияет).
      </p>
      <div className="grid gap-5 sm:grid-cols-2">
        <LogoUploader kind="login-dark" label="Экран входа — тёмная версия" hint="Необязательно. Обычно светлый логотип на прозрачном фоне." />
        <LogoUploader kind="header-dark" label="Сайдбар — тёмная версия" hint="Необязательно." />
      </div>
    </div>
  );
}

function FaviconUploader() {
  const { settings, refresh } = useSiteSettings();
  const { push } = useToast();
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const v = `${settings.faviconUrl ? 'c' : 'd'}${Date.parse(settings.updatedAt) || 0}`;
  const preview = `/api/site-settings/favicon/180?v=${v}`;
  const tabPreview = `/api/site-settings/favicon/32?v=${v}`;

  const upload = async (file: File) => {
    setBusy('upload');
    try {
      await siteApi.uploadFavicon(file);
      refresh();
      push('Favicon обновлён', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось загрузить favicon', 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!confirm('Вернуть стандартный favicon?')) return;
    setBusy('remove');
    try {
      await siteApi.deleteFavicon();
      refresh();
      push('Favicon: стандартный', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось убрать favicon', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <div className="flex shrink-0 items-end gap-2">
        <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-[14px] border border-line/[0.1] bg-surface-sunken" title="Иконка для iPhone / приложения">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="" className="h-full w-full object-contain" />
        </div>
        <div className="flex h-7 items-center gap-1.5 rounded-t-md border border-b-0 border-line/[0.1] bg-surface-raised px-2" title="Так выглядит вкладка браузера">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={tabPreview} alt="" className="h-4 w-4 object-contain" />
          <span className="max-w-[80px] truncate text-2xs text-ink-muted">{settings.siteName}</span>
        </div>
      </div>
      <div className="min-w-0">
        <p className="mb-1.5 text-sm font-medium text-ink">Favicon</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <label className={`btn-secondary btn-sm w-fit cursor-pointer ${busy ? 'pointer-events-none opacity-60' : ''}`}>
            {busy === 'upload' ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {settings.faviconUrl ? 'Заменить' : 'Загрузить'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                e.target.value = '';
              }}
            />
          </label>
          {settings.faviconUrl && (
            <button type="button" onClick={() => void remove()} disabled={!!busy} className="btn-ghost btn-sm hover:text-danger">
              {busy === 'remove' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              Стандартный
            </button>
          )}
        </div>
        <p className="mt-1.5 text-xs text-ink-faint">
          Иконка вкладки браузера, ярлыка на iPhone и установленного приложения. Подойдёт .ico, PNG или SVG (лучше квадрат от 512px) — из него
          сделаются все размеры.
        </p>
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
    <div className="space-y-6">
      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Брендинг</h2>
            <p className="card-desc">Логотипы, favicon и фон видны всем, включая экран входа — ещё до авторизации.</p>
          </div>
          {settings.version && <span className="badge">v{settings.version}</span>}
        </div>
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <LogoUploader kind="login" label="Логотип экрана входа" hint="Крупный — показывается на экране логина." />
          <LogoUploader kind="header" label="Логотип в сайдбаре" hint="Маленький — отдельное изображение, не уменьшенная копия." />
        </div>
        <div className="border-t border-line/[0.06] p-5">
          <DarkLogoSettings />
        </div>
        <div className="border-t border-line/[0.06] p-5">
          <FaviconUploader />
        </div>
        <div className="border-t border-line/[0.06] p-5">
          <LogoUploader
            kind="login-bg"
            label="Фон экрана входа"
            hint="Фото растягивается на весь экран (обрезается по краям под размер окна). Лучше горизонтальное, от 1920px по ширине; форма входа остаётся непрозрачной."
          />
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Основное</h2>
            <p className="card-desc">Название и описание рабочего пространства.</p>
          </div>
        </div>
        <div className="space-y-4 p-5">
          <div>
            <label className="label">Название</label>
            <input value={siteName} onChange={(e) => setSiteName(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label">Описание</label>
            <textarea value={siteDescription} onChange={(e) => setSiteDescription(e.target.value)} rows={2} className="input resize-none" />
            <p className="hint">Показывается на экране входа.</p>
          </div>
          <div>
            <label className="label">Копирайт</label>
            <input value={copyrightText} onChange={(e) => setCopyrightText(e.target.value)} placeholder="© 2026 Моя компания" className="input" />
            <p className="hint">Футер экрана входа и настроек профиля.</p>
          </div>
        </div>
        <div className="flex justify-end border-t border-line/[0.06] bg-surface-panel/60 px-5 py-3">
          <button type="button" onClick={() => void handleSave()} disabled={isSaving} className="btn-primary">
            {isSaving && <Loader2 size={14} className="animate-spin" />}
            Сохранить изменения
          </button>
        </div>
      </section>
    </div>
  );
}
