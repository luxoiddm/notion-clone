import { Router } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';
import { AuthService, requireAuth, requireRole } from '@core/auth';
import { FsEngine } from '@core/fs-engine';
import { asyncRoute } from '../middleware/errorHandler.js';

const uploadLogo = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB — a logo has no business being bigger than that
const LOGO_MAX_DIMENSION = 512; // fit within a 512x512 box, aspect ratio preserved — a logo isn't cropped to a square the way an avatar is

export function adminRoutes(auth: AuthService, engine: FsEngine) {
  const router = Router();

  router.use(requireAuth(auth), requireRole('Admin'));

  // ---- List / edit / delete users (Admin panel) --------------------------

  router.get(
    '/users',
    asyncRoute(async (_req, res) => {
      const [users, credentials] = await Promise.all([engine.listUsers(), engine.getAllCredentials()]);

      const emailByUserId = new Map<string, string>();
      for (const [email, cred] of Object.entries(credentials)) emailByUserId.set(cred.userId, email);

      res.json(users.map((u) => ({ ...u, email: emailByUserId.get(u.id) ?? null })));
    }),
  );

  router.patch(
    '/users/:userId',
    asyncRoute(async (req, res) => {
      const { displayName, role } = req.body as {
        displayName?: string;
        role?: 'Admin' | 'Team-Lead' | 'Member' | 'Guest';
      };
      if (displayName === undefined && role === undefined) {
        return res.status(400).json({ error: 'Nothing to update — provide displayName and/or role' });
      }
      const updated = await engine.updateUser(req.params.userId, {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(role !== undefined ? { role } : {}),
      });
      res.json(updated);
    }),
  );

  router.delete(
    '/users/:userId',
    asyncRoute(async (req, res) => {
      if (req.params.userId === req.user!.id) {
        return res.status(400).json({ error: 'Нельзя удалить свой собственный аккаунт' });
      }
      await engine.deleteUser(req.params.userId);
      res.status(204).end();
    }),
  );

  // Admin-triggered password reset — returns a new one-time temporary
  // password to hand off out-of-band, same shape as user creation.
  router.post(
    '/users/:userId/reset-password',
    asyncRoute(async (req, res) => {
      const credentials = await engine.getAllCredentials();
      const entry = Object.entries(credentials).find(([, cred]) => cred.userId === req.params.userId);
      if (!entry) return res.status(404).json({ error: 'У пользователя нет учётных данных для сброса' });

      const [email] = entry;
      const temporaryPassword = randomBytes(9).toString('base64url');
      const passwordHash = await auth.hashPassword(temporaryPassword);
      await engine.setCredential(email, req.params.userId, passwordHash);

      res.json({ temporaryPassword });
    }),
  );

  // ---- Create a user directly ------------------------------------------

  router.post(
    '/users',
    asyncRoute(async (req, res) => {
      const { email, displayName, role, password } = req.body as {
        email?: string;
        displayName?: string;
        role?: 'Admin' | 'Team-Lead' | 'Member' | 'Guest';
        /** Optional — admin can set a specific password instead of getting a random one. Falls back to auto-generation exactly as before when omitted/empty. */
        password?: string;
      };
      if (!email || !displayName || !role) {
        return res.status(400).json({ error: 'email, displayName and role are required' });
      }
      if (password !== undefined && password !== '' && password.length < 8) {
        return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
      }
      if (await engine.getCredentialByEmail(email)) {
        return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
      }

      const userId = randomUUID();
      const profile = await engine.createUser(userId, { displayName, role });

      const finalPassword = password && password !== '' ? password : randomBytes(9).toString('base64url');
      const passwordHash = await auth.hashPassword(finalPassword);
      await engine.setCredential(email, userId, passwordHash);

      // `temporaryPassword` name kept as-is even for an admin-chosen
      // password — the response shape is the same either way (show it
      // once so the admin can hand it to the new user), callers don't
      // need to know which case happened.
      res.status(201).json({ user: { ...profile, email }, temporaryPassword: finalPassword });
    }),
  );

  // ---- Invite by link -----------------------------------------------------

  router.post(
    '/invites',
    asyncRoute(async (req, res) => {
      const { email, role } = req.body as { email?: string; role?: 'Admin' | 'Team-Lead' | 'Member' | 'Guest' };
      if (!email || !role) return res.status(400).json({ error: 'email and role are required' });

      const inviteToken = auth.signInviteToken(email, role);
      res.status(201).json({ inviteToken, inviteUrl: `/accept-invite?token=${inviteToken}` });
    }),
  );

  // ---- Site settings (name/description/copyright/logo) -------------------
  // Reading is public (see site.routes.ts, mounted without requireAuth) —
  // the login screen needs to show these before anyone's signed in, and
  // the admin panel's own settings form just uses that same public GET
  // rather than duplicating it here. Only the write side belongs here,
  // behind the Admin-only gate this whole router already enforces.

  router.post(
    '/site-settings/logo/:kind',
    uploadLogo.single('logo'),
    asyncRoute(async (req, res) => {
      if (req.params.kind !== 'login' && req.params.kind !== 'header') {
        return res.status(400).json({ error: 'kind must be "login" or "header"' });
      }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      let resized: Buffer;
      try {
        resized = await sharp(req.file.buffer)
          .resize(LOGO_MAX_DIMENSION, LOGO_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90 }) // webp keeps alpha transparency, unlike jpeg — logos are frequently transparent PNGs
          .toBuffer();
      } catch {
        return res.status(400).json({ error: 'Не удалось обработать изображение — убедитесь, что это картинка' });
      }

      const logoUrl = await engine.saveSiteLogo(req.params.kind, resized);
      const patch = req.params.kind === 'login' ? { loginLogoUrl: logoUrl } : { headerLogoUrl: logoUrl };
      const updated = await engine.updateSiteSettings(patch);
      res.json(updated);
    }),
  );

  router.patch(
    '/site-settings',
    asyncRoute(async (req, res) => {
      const { siteName, siteDescription, copyrightText } = req.body as {
        siteName?: string;
        siteDescription?: string;
        copyrightText?: string;
      };
      const patch: Partial<{ siteName: string; siteDescription: string; copyrightText: string }> = {};
      if (siteName !== undefined) patch.siteName = siteName;
      if (siteDescription !== undefined) patch.siteDescription = siteDescription;
      if (copyrightText !== undefined) patch.copyrightText = copyrightText;

      const updated = await engine.updateSiteSettings(patch);
      res.json(updated);
    }),
  );

  return router;
}
