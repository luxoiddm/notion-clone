'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { siteApi, type SiteSettings, type SiteImageKind } from '../lib/api';

const DEFAULTS: SiteSettings = {
  siteName: 'Workspace',
  siteDescription: 'Корпоративная база знаний и командная работа',
  copyrightText: '',
  loginLogoUrl: null,
  headerLogoUrl: null,
  loginBackgroundUrl: null,
  faviconUrl: null,
  loginLogoDarkUrl: null,
  headerLogoDarkUrl: null,
  darkLogoMode: 'auto',
  logoTone: {},
  updatedAt: new Date(0).toISOString(),
  version: '',
};

/**
 * `NEXT_PUBLIC_*` env vars are baked in at build time (see
 * `apps/web/.env.local.example`) — on a `next build` deployment this
 * needs a rebuild to take effect, same caveat as `NEXT_PUBLIC_API_URL`
 * already has. `Number(undefined)`/`Number('')` both fail the `> 0`
 * check below, so an unset *or* empty-string env var both fall through
 * to the hardcoded default instead of silently rendering a 0px logo.
 */
function envPixelSize(envValue: string | undefined, fallback: number): number {
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const LOGIN_LOGO_HEIGHT = envPixelSize(process.env.NEXT_PUBLIC_LOGIN_LOGO_HEIGHT, 64);
export const HEADER_LOGO_HEIGHT = envPixelSize(process.env.NEXT_PUBLIC_HEADER_LOGO_HEIGHT, 32);

interface SiteSettingsContextValue {
  settings: SiteSettings;
  isLoading: boolean;
  /** Re-fetches from the server — call after the admin settings form saves a change, so the rest of the app (title, sidebar, login screen) picks it up without a full page reload. */
  refresh: () => void;
}

const SiteSettingsContext = createContext<SiteSettingsContextValue | null>(null);

export function SiteSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<SiteSettings>(DEFAULTS);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = () => {
    siteApi
      .get()
      .then(setSettings)
      .catch(() => {
        // Public, read-only, and defaults are already reasonable — a
        // failed fetch (offline, backend not up yet) just means the
        // built-in fallback ("Workspace") stays in place, not an error
        // state anyone needs to see or retry.
      })
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.title = settings.siteName;
  }, [settings.siteName]);

  // Иконки в <head> указывают на /api/site-settings/favicon/:size (см.
  // layout.tsx), и сервер сам отдаёт свой favicon или стандартный. Здесь
  // только добавляем ?v=<время изменения настроек>, чтобы уже открытые
  // вкладки и кэш браузера сразу подхватили новую иконку после замены.
  useEffect(() => {
    if (settings.updatedAt === DEFAULTS.updatedAt) return;
    const v = `${settings.faviconUrl ? 'c' : 'd'}${Date.parse(settings.updatedAt) || 0}`;
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]').forEach((link) => {
      const url = new URL(link.href, window.location.origin);
      if (!url.pathname.startsWith('/api/site-settings/favicon/')) return;
      url.searchParams.set('v', v);
      link.href = url.pathname + url.search;
    });
  }, [settings.faviconUrl, settings.updatedAt]);

  return <SiteSettingsContext.Provider value={{ settings, isLoading, refresh }}>{children}</SiteSettingsContext.Provider>;
}

export function useSiteSettings() {
  const ctx = useContext(SiteSettingsContext);
  if (!ctx) throw new Error('useSiteSettings must be used within SiteSettingsProvider');
  return ctx;
}

/**
 * The requested logo's URL with a cache-busting query string — a browser
 * that already cached the old logo at this same path otherwise has no
 * reason to re-fetch after an admin replaces it (see saveSiteLogo's doc
 * comment in FsEngine). `kind` picks which of the two independent logos
 * (login screen vs. header) to resolve — they're deliberately separate
 * images, not the same one reused at two sizes.
 */
export function logoUrlWithCacheBust(settings: SiteSettings, kind: SiteImageKind): string | null {
  const url = {
    login: settings.loginLogoUrl,
    header: settings.headerLogoUrl,
    'login-bg': settings.loginBackgroundUrl,
    'login-dark': settings.loginLogoDarkUrl,
    'header-dark': settings.headerLogoDarkUrl,
  }[kind];
  if (!url) return null;
  return `${url}?v=${encodeURIComponent(settings.updatedAt)}`;
}

/** Инвертировать ли основной логотип в тёмной теме (когда отдельной тёмной версии нет). */
export function shouldInvertLogoInDark(settings: SiteSettings, kind: 'login' | 'header'): boolean {
  if (settings.darkLogoMode === 'invert') return true;
  if (settings.darkLogoMode === 'none') return false;
  return settings.logoTone?.[kind] === 'dark';
}

/**
 * Логотип сайта с учётом темы: в тёмной теме — отдельная тёмная версия,
 * если загружена, иначе основной логотип (при необходимости
 * инвертированный: invert + hue-rotate(180°) делает чёрное белым, но
 * сохраняет оттенки цветных элементов). null — логотипа нет.
 */
export function SiteLogo({
  settings,
  kind,
  className,
  style,
  forceTheme,
}: {
  settings: SiteSettings;
  kind: 'login' | 'header';
  className?: string;
  style?: React.CSSProperties;
  /** Для превью в админке: показать вариант конкретной темы независимо от текущей. */
  forceTheme?: 'light' | 'dark';
}) {
  const light = logoUrlWithCacheBust(settings, kind);
  if (!light) return null;
  const dark = logoUrlWithCacheBust(settings, kind === 'login' ? 'login-dark' : 'header-dark');
  if (forceTheme) {
    const src = forceTheme === 'dark' && dark ? dark : light;
    const filter = forceTheme === 'dark' && !dark && shouldInvertLogoInDark(settings, kind) ? 'invert(1) hue-rotate(180deg)' : undefined;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={settings.siteName} style={{ ...style, filter }} className={className} />;
  }
  if (dark) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={light} alt={settings.siteName} style={style} className={`${className ?? ''} dark:hidden`} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={dark} alt={settings.siteName} style={style} className={`${className ?? ''} hidden dark:block`} />
      </>
    );
  }
  const invert = shouldInvertLogoInDark(settings, kind) ? 'dark:[filter:invert(1)_hue-rotate(180deg)]' : '';
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={light} alt={settings.siteName} style={style} className={`${className ?? ''} ${invert}`} />;
}
