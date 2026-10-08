import type { MetadataRoute } from 'next';

/**
 * Placeholder icon/name — this file ships with the codebase and isn't
 * tied to the admin-configurable site name/logo (SiteSettings), which
 * only exists as data on a running server, not something a static build
 * artifact like this can read. A deployer who wants their own branding
 * here should update `name`/`short_name` below. Иконки задаются в
 * админке («Настройки сайта» → «Брендинг» → Favicon) и отдаются сервером;
 * apps/web/public/icon-*.png — только стандартный вариант по умолчанию.
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
      // Через сервер — свой favicon из админки или стандартная иконка.
      { src: '/api/site-settings/favicon/192', sizes: '192x192', type: 'image/png' },
      { src: '/api/site-settings/favicon/512', sizes: '512x512', type: 'image/png' },
    ],
  };
}
