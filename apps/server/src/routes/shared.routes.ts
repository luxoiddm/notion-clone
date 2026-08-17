import { Router } from 'express';
import { AuthService, requireAuth } from '@core/auth';
import { FsEngine } from '@core/fs-engine';
import { asyncRoute } from '../middleware/errorHandler.js';
import { readLimiter } from '../middleware/rateLimiter.js';

export function sharedRoutes(auth: AuthService, engine: FsEngine) {
  const router = Router();
  router.use(requireAuth(auth));

  router.get(
    '/',
    readLimiter,
    asyncRoute(async (req, res) => {
      const pages = await engine.listSharedPages(req.user!.id);
      res.json(pages);
    }),
  );

  return router;
}
