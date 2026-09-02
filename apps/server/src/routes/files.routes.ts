import { Router } from 'express';
import multer from 'multer';
import { AuthService, requireAuth } from '@core/auth';
import { FsEngine } from '@core/fs-engine';
import { asyncRoute } from '../middleware/errorHandler.js';
import { documentWriteLimiter, readLimiter } from '../middleware/rateLimiter.js';

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB per file, same cap as page assets

/**
 * Each user's personal file storage — independent of any single page, so
 * a file can be uploaded once and then inserted into any number of
 * articles (or none). Backed by `FsEngine.saveUserFile` /
 * `STORAGE_ROOT/users/{userId}/files/`.
 */
export function filesRoutes(auth: AuthService, engine: FsEngine) {
  const router = Router();
  router.use(requireAuth(auth));

  router.get(
    '/',
    readLimiter,
    asyncRoute(async (req, res) => {
      res.json(await engine.listUserFiles(req.user!.id));
    }),
  );

  router.post(
    '/',
    documentWriteLimiter,
    upload.single('file'),
    asyncRoute(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const info = await engine.saveUserFile(req.user!.id, req.file.originalname, req.file.buffer, req.file.mimetype);
      res.status(201).json(info);
    }),
  );

  router.delete(
    '/:fileName',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      await engine.deleteUserFile(req.user!.id, req.params.fileName!);
      res.status(204).end();
    }),
  );

  /**
   * Serves a file's raw bytes. Deliberately allows ANY authenticated user
   * to fetch by exact (userId, fileName) — not just the owner. `fileName`
   * is a server-generated, unguessable token (timestamp + random suffix),
   * so this is effectively a capability URL, the same trust model as the
   * existing "anyone with the link" page-sharing option. This is what
   * lets an image inserted into a *shared* article actually render for
   * the person it was shared with. See agent.md for the full tradeoff.
   */
  router.get(
    '/serve/:userId/:fileName',
    readLimiter,
    asyncRoute(async (req, res) => {
      const filePath = engine.getUserFileAbsolutePath(req.params.userId!, req.params.fileName!);
      res.sendFile(filePath);
    }),
  );

  return router;
}
