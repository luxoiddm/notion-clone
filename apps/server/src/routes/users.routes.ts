import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { AuthService, requireAuth } from '@core/auth';
import { FsEngine } from '@core/fs-engine';
import { asyncRoute } from '../middleware/errorHandler.js';
import { documentWriteLimiter } from '../middleware/rateLimiter.js';

// Square, small enough to stay a handful of KB as WebP, large enough not
// to look blurry in anything bigger than a tiny presence dot (e.g. the
// settings page's own preview).
const AVATAR_SIZE = 256;

/**
 * Deliberately minimal — no email, no role — so any authenticated user
 * (not just Admins) can resolve a userId to a display name for @mentions,
 * the share dialog's user picker, and "shared with me" owner labels.
 * Full user records (with email) live behind `/api/admin/users`.
 * avatarUrl/accentColor *are* included here (unlike email/role) — unlike
 * those, they're meant to be visible to everyone, the same way a display
 * name is: presence, chat message authors, and anywhere else someone's
 * identity is shown need them.
 */
export function usersRoutes(auth: AuthService, engine: FsEngine) {
  const router = Router();
  router.use(requireAuth(auth));

  router.get(
    '/',
    asyncRoute(async (_req, res) => {
      const users = await engine.listUsers();
      res.json(users.map((u) => ({ id: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl, accentColor: u.accentColor })));
    }),
  );

  // Self-service — accentColor only here; avatarUrl is set exclusively
  // through POST /me/avatar below, which resizes the image before ever
  // writing avatarUrl, so this route can't be used to point it at an
  // arbitrary/oversized/unvalidated URL instead.
  router.patch(
    '/me',
    asyncRoute(async (req, res) => {
      const { accentColor } = req.body as { accentColor?: string | null };
      const updated = await engine.updateOwnProfile(req.user!.id, { accentColor: accentColor ?? null });
      res.json({ id: updated.id, displayName: updated.displayName, avatarUrl: updated.avatarUrl, accentColor: updated.accentColor });
    }),
  );

  // Takes a *reference* to a file already sitting in the caller's own
  // personal storage (`sourceFileName`) rather than accepting a fresh
  // multipart upload directly — the frontend's FilePickerDialog already
  // uploads a freshly-picked file to personal storage before it ever
  // calls back with a result, so "upload a new photo" and "reuse a file
  // I already have" end up as the exact same request here, no special
  // casing needed for either path.
  router.post(
    '/me/avatar',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { sourceFileName } = req.body as { sourceFileName?: string };
      if (!sourceFileName) return res.status(400).json({ error: 'sourceFileName is required' });

      const sourcePath = engine.getUserFileAbsolutePath(req.user!.id, sourceFileName);
      let sourceBuffer: Buffer;
      try {
        sourceBuffer = await readFile(sourcePath);
      } catch {
        return res.status(404).json({ error: 'Исходный файл не найден в вашем хранилище' });
      }

      let resized: Buffer;
      try {
        resized = await sharp(sourceBuffer)
          .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
          .webp({ quality: 85 })
          .toBuffer();
      } catch {
        return res.status(400).json({ error: 'Не удалось обработать изображение — убедитесь, что это картинка' });
      }

      const previous = await engine.getUser(req.user!.id);
      const saved = await engine.saveUserFile(req.user!.id, 'avatar.webp', resized, 'image/webp');
      const updated = await engine.updateOwnProfile(req.user!.id, { avatarUrl: saved.url });

      // Changing your avatar repeatedly shouldn't quietly pile up
      // orphaned old avatar files in your personal storage forever —
      // clean up the one this replaces, if any. Runs *after* the new one
      // is already set, so a failure here never leaves the account with
      // no avatar at all.
      if (previous.avatarUrl) {
        const previousFileName = previous.avatarUrl.split('/').pop();
        if (previousFileName && previousFileName !== saved.fileName) {
          await engine.deleteUserFile(req.user!.id, previousFileName).catch(() => undefined);
        }
      }

      res.json({ id: updated.id, displayName: updated.displayName, avatarUrl: updated.avatarUrl, accentColor: updated.accentColor });
    }),
  );

  return router;
}
