import { Router } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';
import { AuthService, requireAuth, requireRole } from '@core/auth';
import { FsEngine, SITE_IMAGE_KINDS, FAVICON_SIZES, DARK_LOGO_MODES, type SiteImageKind, type FaviconSize, type DarkLogoMode } from '@core/fs-engine';
import { detectLogoTone } from '../lib/logoTone.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { decodeIco } from '../lib/ico.js';

const uploadLogo = multer({ limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB — с запасом под фоновое фото экрана входа (логотипы обычно гораздо меньше)
const BACKGROUND_MAX_DIMENSION = 2560;
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

      res.json(users.map((u) => ({ ...u, email: emailByUserId.get(u.id) ?? null, folder: engine.userFolderRelative(u.id) })));
    }),
  );

  router.patch(
    '/users/:userId',
    asyncRoute(async (req, res) => {
      const { displayName, role, enabled } = req.body as {
        displayName?: string;
        role?: 'Admin' | 'Team-Lead' | 'Member' | 'Guest';
        enabled?: boolean;
      };
      if (displayName === undefined && role === undefined && enabled === undefined) {
        return res.status(400).json({ error: 'Nothing to update — provide displayName, role and/or enabled' });
      }
      if (enabled === false && req.params.userId! === req.user!.id) {
        return res.status(400).json({ error: 'Нельзя отключить свой собственный аккаунт' });
      }
      const updated = await engine.updateUser(req.params.userId!, {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      });
      res.json(updated);
    }),
  );

  router.delete(
    '/users/:userId',
    asyncRoute(async (req, res) => {
      if (req.params.userId! === req.user!.id) {
        return res.status(400).json({ error: 'Нельзя удалить свой собственный аккаунт' });
      }
      await engine.deleteUser(req.params.userId!);
      res.status(204).end();
    }),
  );

  // «Уволить»: папка пользователя целиком переезжает в STORAGE_ROOT/dismissed/,
  // вход запрещён. Ссылки на его документы и файлы (по id) продолжают работать.
  router.post(
    '/users/:userId/dismiss',
    asyncRoute(async (req, res) => {
      if (req.params.userId! === req.user!.id) return res.status(400).json({ error: 'Нельзя уволить самого себя' });
      res.json(await engine.dismissUser(req.params.userId!));
    }),
  );

  router.post(
    '/users/:userId/restore',
    asyncRoute(async (req, res) => {
      res.json(await engine.restoreUser(req.params.userId!));
    }),
  );

  // Admin-triggered password reset — returns a new one-time temporary
  // password to hand off out-of-band, same shape as user creation.
  router.post(
    '/users/:userId/reset-password',
    asyncRoute(async (req, res) => {
      const credentials = await engine.getAllCredentials();
      const entry = Object.entries(credentials).find(([, cred]) => cred.userId === req.params.userId!);
      if (!entry) return res.status(404).json({ error: 'У пользователя нет учётных данных для сброса' });

      const [email] = entry;
      const temporaryPassword = randomBytes(9).toString('base64url');
      const passwordHash = await auth.hashPassword(temporaryPassword);
      await engine.setCredential(email, req.params.userId!, passwordHash);

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

  // Картинки сайта: 'login' / 'header' — логотипы, 'login-bg' — фоновое
  // фото экрана входа. Загрузка (POST) и удаление (DELETE, «без логотипа»).
  router.post(
    '/site-settings/logo/:kind',
    uploadLogo.single('logo'),
    asyncRoute(async (req, res) => {
      const kind = req.params.kind as SiteImageKind;
      if (!SITE_IMAGE_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of: ${SITE_IMAGE_KINDS.join(', ')}` });
      }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      let resized: Buffer;
      try {
        resized =
          kind === 'login-bg'
            ? // Фон — полноэкранное фото: ужимаем до 2560px по большей стороне, прозрачность не нужна.
              await sharp(req.file.buffer)
                .rotate()
                .resize(BACKGROUND_MAX_DIMENSION, BACKGROUND_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 82 })
                .toBuffer()
            : await sharp(req.file.buffer)
                .resize(LOGO_MAX_DIMENSION, LOGO_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 90 }) // webp keeps alpha transparency, unlike jpeg — logos are frequently transparent PNGs
                .toBuffer();
      } catch {
        return res.status(400).json({ error: 'Не удалось обработать изображение — убедитесь, что это картинка' });
      }

      const url = await engine.saveSiteLogo(kind, resized);
      let updated = await engine.updateSiteSettings({ [FsEngine.siteImageField(kind)]: url });
      // Для основных логотипов запоминаем тон — по нему тёмная тема решает, инвертировать ли.
      if (kind === 'login' || kind === 'header') {
        const tone = await detectLogoTone(resized).catch(() => 'light' as const);
        updated = await engine.updateSiteSettings({ logoTone: { ...updated.logoTone, [kind]: tone } });
      }
      res.json(updated);
    }),
  );

  router.delete(
    '/site-settings/logo/:kind',
    asyncRoute(async (req, res) => {
      const kind = req.params.kind as SiteImageKind;
      if (!SITE_IMAGE_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of: ${SITE_IMAGE_KINDS.join(', ')}` });
      }
      res.json(await engine.deleteSiteImage(kind));
    }),
  );

  // Favicon: из загруженной картинки (PNG/JPG/WebP/SVG или .ico) режем
  // квадратные PNG 32/180/192/512 (с прозрачными полями, без обрезки).
  router.post(
    '/site-settings/favicon',
    uploadLogo.single('favicon'),
    asyncRoute(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const isIco =
        /\.ico$/i.test(req.file.originalname) || ['image/x-icon', 'image/vnd.microsoft.icon'].includes(req.file.mimetype);
      if (isIco && req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'Файл .ico слишком большой (максимум 2 МБ)' });

      // .ico sharp не читает — сначала достаём из него самую большую
      // картинку (decodeIco). Иначе из .ico получилась бы только иконка
      // вкладки, а для 192/512 браузер брал бы стандартную — и именно её
      // Chrome предпочитает показывать во вкладке.
      let source: sharp.Sharp | null = null;
      if (isIco) {
        const decoded = decodeIco(req.file.buffer);
        if (decoded?.kind === 'png') source = sharp(decoded.data);
        else if (decoded?.kind === 'raw')
          source = sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } });
        if (!source) return res.status(400).json({ error: 'Не удалось прочитать .ico — загрузите PNG или SVG' });
      } else {
        source = sharp(req.file.buffer, { density: 300 });
      }

      try {
        const png: Partial<Record<FaviconSize, Buffer>> = {};
        for (const size of FAVICON_SIZES) {
          png[size] = await source
            .clone()
            .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
        }
        // Исходный .ico тоже сохраняем — отдаётся по /favicon.ico-совместимому запросу для вкладки.
        res.json(await engine.saveFavicon({ png, ico: isIco ? req.file.buffer : undefined }));
      } catch {
        res.status(400).json({ error: 'Не удалось обработать изображение — загрузите PNG, JPG, WebP, SVG или ICO' });
      }
    }),
  );

  router.delete(
    '/site-settings/favicon',
    asyncRoute(async (_req, res) => {
      res.json(await engine.deleteFavicon());
    }),
  );

  router.patch(
    '/site-settings',
    asyncRoute(async (req, res) => {
      const { siteName, siteDescription, copyrightText, darkLogoMode } = req.body as {
        siteName?: string;
        siteDescription?: string;
        copyrightText?: string;
        darkLogoMode?: DarkLogoMode;
      };
      const patch: Partial<{ siteName: string; siteDescription: string; copyrightText: string; darkLogoMode: DarkLogoMode }> = {};
      if (darkLogoMode !== undefined) {
        if (!DARK_LOGO_MODES.includes(darkLogoMode)) return res.status(400).json({ error: 'darkLogoMode must be auto, invert or none' });
        patch.darkLogoMode = darkLogoMode;
      }
      if (siteName !== undefined) patch.siteName = siteName;
      if (siteDescription !== undefined) patch.siteDescription = siteDescription;
      if (copyrightText !== undefined) patch.copyrightText = copyrightText;

      const updated = await engine.updateSiteSettings(patch);
      res.json(updated);
    }),
  );

  return router;
}
