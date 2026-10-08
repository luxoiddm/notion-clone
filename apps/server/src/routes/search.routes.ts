import { Router } from 'express';
import { AuthService, requireAuth } from '@core/auth';
import { FsEngine } from '@core/fs-engine';
import { asyncRoute } from '../middleware/errorHandler.js';
import { readLimiter } from '../middleware/rateLimiter.js';

/**
 * Global search — every page the requester can actually see: their own
 * (across all of their own projects) plus everything shared with them by
 * anyone else. Not scoped under `/storage/:userId/:projectId` like
 * `searchPages` (used for the in-editor sidebar search, one project at a
 * time) — this one has no single owner/project to scope a path to, it
 * spans all of them, so it's its own top-level route, same pattern as
 * `/api/shared` (`shared.routes.ts`) for the same reason.
 */
export function searchRoutes(auth: AuthService, engine: FsEngine) {
  const router = Router();
  router.use(requireAuth(auth));

  router.get(
    '/',
    readLimiter,
    asyncRoute(async (req, res) => {
      const q = (req.query.q as string) || '';
      res.json(await engine.searchVisiblePages(req.user!.id, q));
    }),
  );

  return router;
}
