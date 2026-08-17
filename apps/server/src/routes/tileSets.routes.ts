import { Router } from 'express';
import sharp from 'sharp';
import { FsEngine } from '@core/fs-engine';
import { asyncRoute } from '../middleware/errorHandler.js';
import { readLimiter } from '../middleware/rateLimiter.js';

/**
 * Public (no requireAuth) — same reasoning as site.routes.ts: these are
 * shared, non-sensitive decorative images (not tied to any one user's
 * private data), and a page's icon needs to be visible to anyone who can
 * see the page, not just its owner looking at the picker.
 */
export function tileSetsRoutes(engine: FsEngine) {
  const router = Router();

  router.get(
    '/',
    readLimiter,
    asyncRoute(async (_req, res) => {
      res.json(await engine.listTileSets());
    }),
  );

  router.get(
    '/:setName/:tileId',
    readLimiter,
    asyncRoute(async (req, res) => {
      const resolved = await engine.resolveTile(req.params.setName, req.params.tileId);
      if (!resolved) {
        return res.status(404).json({ error: 'Tile set or tile not found' });
      }

      let image: Buffer;
      try {
        if (resolved.kind === 'sprite-sheet') {
          // cols/tileSize come from resolveTile(), not a separate copy
          // of the config here — FsEngine's constructor options (in
          // turn read from TILE_SHEET_COLS/ROWS/SIZE in apps/server's
          // .env) are the one place this grid layout is defined.
          const row = Math.floor(resolved.index / resolved.cols);
          const col = resolved.index % resolved.cols;
          image = await sharp(resolved.absolutePath)
            .extract({ left: col * resolved.tileSize, top: row * resolved.tileSize, width: resolved.tileSize, height: resolved.tileSize })
            .png()
            .toBuffer();
        } else {
          // Individually-cut file from a folder set — not resized (the
          // picker's CSS already constrains display size regardless of
          // source dimensions), but still normalized to PNG output:
          // TILE_IMAGE_EXTENSIONS in FsEngine also accepts .jpg/.webp,
          // and without an explicit .png() call sharp preserves
          // whatever format the source file actually is, which would
          // mismatch the Content-Type header set unconditionally below.
          image = await sharp(resolved.absolutePath).png().toBuffer();
        }
      } catch {
        // Covers "sharp couldn't read/process the file" (corrupt image,
        // wrong format despite the extension, etc.) — resolveTile()
        // already confirmed the file exists, so this is specifically an
        // image-processing failure, not a missing-file one.
        return res.status(404).json({ error: 'Tile set or tile not found' });
      }

      res.setHeader('Content-Type', 'image/png');
      // Tile images are static, placed on disk by whoever deploys the
      // server — not something that changes at runtime, safe to cache
      // aggressively client-side.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(image);
    }),
  );

  return router;
}
