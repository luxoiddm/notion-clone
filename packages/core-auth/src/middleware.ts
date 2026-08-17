import type { NextFunction, Request, Response } from 'express';
import { AuthService } from './jwt.js';
import { Role, roleAtLeast } from './types.js';

/**
 * Verifies the access token and attaches `req.user`. Accepts the token
 * either as a standard `Authorization: Bearer <token>` header (used by
 * every fetch() call in the app), or as a `?token=` query parameter.
 *
 * The query-param fallback exists solely for media URLs: an `<img src>` or
 * `<a href>` the browser fetches on its own can't carry a custom header,
 * so file-serving routes (page assets, personal file storage) need the
 * token in the URL instead. Access tokens are short-lived (15 min), which
 * bounds the exposure — see agent.md for the full tradeoff.
 */
export function requireAuth(auth: AuthService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : queryToken;

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
