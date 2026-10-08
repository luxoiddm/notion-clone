import type { NextFunction, Request, Response } from 'express';
import { AuthService } from './jwt.js';
import { Role, roleAtLeast } from './types.js';

/** Имя httpOnly-cookie с копией access-токена — для медиа (см. readRequestToken). */
export const MEDIA_COOKIE = 'mediaToken';

/**
 * Access-токен запроса: из `Authorization: Bearer <token>` (все fetch()
 * приложения) или — только для GET/HEAD — из httpOnly-cookie `mediaToken`.
 *
 * Cookie нужна для URL, которые браузер запрашивает сам (`<img src>`,
 * `<video src>`, `<iframe>` предпросмотра, ссылка «Скачать»): к ним нельзя
 * добавить заголовок. Раньше токен передавался в `?token=` — и ссылка,
 * скопированная из адресной строки, открывалась у любого (в т.ч. в
 * инкогнито). Cookie в URL не попадает и в другой браузер не переносится.
 * Для изменяющих запросов cookie не принимается (защита от CSRF).
 */
export function readRequestToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  if (req.method === 'GET' || req.method === 'HEAD') {
    const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[MEDIA_COOKIE];
    if (typeof cookie === 'string' && cookie) return cookie;
  }
  return undefined;
}

/** Verifies the access token (see readRequestToken) and attaches `req.user`. */
export function requireAuth(auth: AuthService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readRequestToken(req);

    if (!token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    try {
      const payload = auth.verifyAccessToken(token);
      req.user = { id: payload.sub, role: payload.role, displayName: payload.displayName };
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

/** Requires the authenticated user's role to be at least `minimum` in the RBAC hierarchy. */
export function requireRole(minimum: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roleAtLeast(req.user.role, minimum)) {
      return res.status(403).json({ error: `Requires role >= ${minimum}` });
    }
    next();
  };
}

/**
 * Core storage-isolation guard: blocks any request to /api/storage/:userId/*
 * where :userId does not match the authenticated caller — UNLESS the page
 * being accessed has an explicit sharing entry for this user (checked by
 * the route handler after this middleware, since that requires reading
 * meta.json). This middleware handles the cheap, universal case: nobody
 * can browse another user's *root* folder by editing the URL, ever.
 */
export function requireOwnStorageOrShared(getUserIdFromParams: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

    const targetUserId = getUserIdFromParams(req);
    if (targetUserId === req.user.id || req.user.role === 'Admin') {
      return next();
    }

    // Not the owner and not an admin — route handler must verify a sharing
    // grant exists on the specific page before proceeding. We flag intent
    // here so handlers don't forget the check.
    req.requiresSharingCheck = true;
    next();
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    requiresSharingCheck?: boolean;
  }
}
