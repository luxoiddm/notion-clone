'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { siteApi, type SiteSettings } from '../lib/api';

const DEFAULTS: SiteSettings = {
  siteName: 'Workspace',
  siteDescription: 'Корпоративная база знаний и командная работа',
  copyrightText: '',
  loginLogoUrl: null,
  headerLogoUrl: null,
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
export function logoUrlWithCacheBust(settings: SiteSettings, kind: 'login' | 'header'): string | null {
  const url = kind === 'login' ? settings.loginLogoUrl : settings.headerLogoUrl;
  if (!url) return null;
  return `${url}?v=${encodeURIComponent(settings.updatedAt)}`;
}
