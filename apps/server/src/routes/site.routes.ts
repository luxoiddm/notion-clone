import { Router } from 'express';
import { FsEngine } from '@core/fs-engine';
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
      if (req.params.kind! !== 'login' && req.params.kind! !== 'header') {
        return res.status(400).json({ error: 'kind must be "login" or "header"' });
      }
      res.sendFile(engine.getSiteLogoAbsolutePath(req.params.kind!));
    }),
  );

  return router;
}
