import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { AuthService, requireAuth } from '@core/auth';
import { FsEngine } from '@core/fs-engine';
import { asyncRoute } from '../middleware/errorHandler.js';

export function authRoutes(auth: AuthService, fs: FsEngine) {
  const router = Router();

  // Returns the caller's profile for a valid access token — used by the
  // frontend to restore session state after a hard refresh or when
  // opening a new tab, once it has exchanged the refresh cookie for a
  // fresh access token via /refresh. Reads fresh from disk rather than
  // trusting the JWT's own claims: the token is a snapshot from
  // login/refresh time, so avatarUrl/accentColor changes (which don't
  // themselves mint a new token) would otherwise only show up after the
  // next refresh instead of immediately.
  router.get(
    '/me',
    requireAuth(auth),
    asyncRoute(async (req, res) => {
      const profile = await fs.getUser(req.user!.id);
      res.json({ id: profile.id, role: profile.role, displayName: profile.displayName, avatarUrl: profile.avatarUrl, accentColor: profile.accentColor });
    }),
  );

  router.post(
    '/login',
    asyncRoute(async (req, res) => {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

      const cred = await fs.getCredentialByEmail(email);
      if (!cred) {
        console.warn(`[auth] Login failed: no credential found for email "${email}"`);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      if (!(await auth.verifyPassword(password, cred.passwordHash))) {
        console.warn(`[auth] Login failed: wrong password for email "${email}" (userId=${cred.userId})`);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const profile = await fs.getUser(cred.userId);
      if (!profile.enabled) {
        console.warn(`[auth] Login rejected: account disabled (userId=${cred.userId})`);
        return res.status(403).json({ error: 'This account has been disabled' });
      }
      const payload = { sub: cred.userId, role: profile.role, displayName: profile.displayName };
      const accessToken = auth.signAccessToken(payload);
      const refreshToken = auth.signRefreshToken(payload);

      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      res.json({
        accessToken,
        user: { id: cred.userId, role: profile.role, displayName: profile.displayName, avatarUrl: profile.avatarUrl, accentColor: profile.accentColor },
      });
    }),
  );

  router.post(
    '/refresh',
    asyncRoute(async (req, res) => {
      const token = req.cookies?.refreshToken as string | undefined;
      if (!token) return res.status(401).json({ error: 'No refresh token' });

      const payload = auth.verifyRefreshToken(token);
      // Re-checks enabled against the current profile on disk, not the
      // refresh token's own (possibly stale) payload — otherwise
      // disabling someone wouldn't actually take effect until their
      // 15-minute access token expired on its own, and they'd just keep
      // refreshing past that indefinitely with the still-valid cookie.
      const profile = await fs.getUser(payload.sub);
      if (!profile.enabled) {
        res.clearCookie('refreshToken');
        return res.status(403).json({ error: 'This account has been disabled' });
      }
      const accessToken = auth.signAccessToken({ sub: payload.sub, role: profile.role, displayName: profile.displayName });
      res.json({ accessToken });
    }),
  );

  router.post('/logout', (_req, res) => {
    res.clearCookie('refreshToken');
    res.status(204).end();
  });

  /**
   * The only way an account is ever created outside the admin panel:
   * consuming a signed invite token that an Admin generated and sent out
   * of-band (email/Slack). There is no public "sign up" endpoint.
   */
  router.post(
    '/accept-invite',
    asyncRoute(async (req, res) => {
      const { inviteToken, password, displayName } = req.body as {
        inviteToken?: string;
        password?: string;
        displayName?: string;
      };
      if (!inviteToken || !password || !displayName) {
        return res.status(400).json({ error: 'inviteToken, password and displayName are required' });
      }

      const { email, role } = auth.verifyInviteToken(inviteToken);
      if (await fs.getCredentialByEmail(email)) {
        return res.status(409).json({ error: 'This invite has already been used' });
      }

      const userId = randomUUID();
      await fs.createUser(userId, { displayName, role });

      const passwordHash = await auth.hashPassword(password);
      await fs.setCredential(email, userId, passwordHash);

      const payload = { sub: userId, role, displayName };
      res.json({ accessToken: auth.signAccessToken(payload), user: { id: userId, role, displayName, avatarUrl: null, accentColor: null } });
    }),
  );

  /**
   * Manual fallback for creating the first Admin over HTTP. Only works
   * while the workspace has zero users — the primary bootstrap path is
   * `seedAdminFromEnv()` below, driven by ADMIN_EMAIL/ADMIN_PASSWORD in
   * `.env` at server startup.
   */
  router.post(
    '/bootstrap-admin',
    asyncRoute(async (req, res) => {
      if (await fs.hasAnyUsers()) {
        return res.status(403).json({ error: 'Workspace is already initialized — use an invite instead.' });
      }

      const { email, password, displayName } = req.body as { email?: string; password?: string; displayName?: string };
      if (!email || !password || !displayName) {
        return res.status(400).json({ error: 'email, password and displayName are required' });
      }

      const userId = randomUUID();
      const profile = await fs.createUser(userId, { displayName, role: 'Admin' });

      const passwordHash = await auth.hashPassword(password);
      await fs.setCredential(email, userId, passwordHash);

      const payload = { sub: userId, role: profile.role, displayName: profile.displayName };
      res
        .status(201)
        .json({ accessToken: auth.signAccessToken(payload), user: { id: userId, role: profile.role, displayName, avatarUrl: profile.avatarUrl, accentColor: profile.accentColor } });
    }),
  );

  return router;
}

/**
 * Auto-creates the first Admin account from ADMIN_EMAIL / ADMIN_PASSWORD
 * (and optional ADMIN_DISPLAY_NAME) in `.env`, called once at server
 * startup (see `apps/server/src/index.ts`). Idempotent per email: if a
 * credential for ADMIN_EMAIL already exists (from a previous run), this
 * no-ops and leaves it untouched — it never resets an existing password.
 */
export async function seedAdminFromEnv(auth: AuthService, fs: FsEngine): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = await fs.getCredentialByEmail(email);
  if (existing) {
    console.log(`[bootstrap] Учётные данные для ${email} уже существуют (userId=${existing.userId}) — пропускаю.`);
    return;
  }

  const displayName = process.env.ADMIN_DISPLAY_NAME || 'Администратор';
  const userId = randomUUID();
  await fs.createUser(userId, { displayName, role: 'Admin' });

  const passwordHash = await auth.hashPassword(password);
  await fs.setCredential(email, userId, passwordHash);

  console.log(`[bootstrap] Создан аккаунт администратора для ${email} (userId=${userId}), роль Admin.`);
}
