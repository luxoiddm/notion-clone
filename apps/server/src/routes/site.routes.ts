import { Router } from 'express';
import { FsEngine, SITE_IMAGE_KINDS, FAVICON_SIZES, type SiteImageKind, type FaviconSize } from '@core/fs-engine';
import { asyncRoute } from '../middleware/errorHandler.js';
import { readLimiter } from '../middleware/rateLimiter.js';

/**
 * Deliberately the only route in this app with no `requireAuth` — the
 * login screen, the browser tab title, and anything else rendered before
 * a session exists all need the site name/description/logo. Read-only:
 * writing lives behind `PATCH /api/admin/site-settings`
 * (admin.routes.ts), gated by the Admin-only middleware that whole
 * router already applies. Nothing returned here is sensitive — it's the
 * same information a plain visit to the login page already shows in the
 * page source.
 */
export function siteRoutes(engine: FsEngine, version: string) {
  const router = Router();

  router.get(
    '/',
    readLimiter,
    asyncRoute(async (_req, res) => {
      // `version` is computed from apps/server/package.json at process
      // startup (see index.ts), not stored in site-settings.json — it
      // isn't something an admin configures, so it deliberately can't be
      // set through PATCH /api/admin/site-settings the way the other
      // fields here can.
      res.json({ ...(await engine.getSiteSettings()), version });
    }),
  );

  router.get(
    '/logo/:kind',
    readLimiter,
    asyncRoute(async (req, res) => {
      const kind = req.params.kind as SiteImageKind;
      if (!SITE_IMAGE_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of: ${SITE_IMAGE_KINDS.join(', ')}` });
      }
      res.sendFile(engine.getSiteLogoAbsolutePath(kind), (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    }),
  );

  // Favicon — публично, как и логотипы. Все иконки сайта (вкладка,
  // iPhone, манифест PWA) ссылаются сюда, поэтому смена favicon в админке
  // работает без пересборки. Если свой favicon не загружен — редирект на
  // стандартный файл из apps/web/public.
  const DEFAULT_ICON: Record<FaviconSize, string> = {
    32: '/icon-192.png',
    180: '/apple-touch-icon.png',
    192: '/icon-192.png',
    512: '/icon-512.png',
  };
  router.get(
    '/favicon/:size',
    readLimiter,
    asyncRoute(async (req, res) => {
      const size = Number(req.params.size) as FaviconSize;
      if (!FAVICON_SIZES.includes(size)) return res.status(400).json({ error: `size must be one of ${FAVICON_SIZES.join(', ')}` });
      const found = await engine.resolveFavicon(size);
      // Браузеры держат favicon в кэше очень долго — просим перепроверять
      // (ETag/Last-Modified от sendFile), чтобы замена была видна сразу.
      res.setHeader('Cache-Control', 'no-cache');
      if (!found) return res.redirect(302, DEFAULT_ICON[size]);
      res.type(found.type);
      res.sendFile(found.path, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    }),
  );

  return router;
}
