import type { MetadataRoute } from 'next';

/**
 * Placeholder icon/name — this file ships with the codebase and isn't
 * tied to the admin-configurable site name/logo (SiteSettings), which
 * only exists as data on a running server, not something a static build
 * artifact like this can read. A deployer who wants their own branding
 * here should replace apps/web/public/icon-192.png and icon-512.png,
 * and update `name`/`short_name` below to match.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Workspace',
    short_name: 'Workspace',
    description: 'Корпоративная база знаний и командная работа',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#111827',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
