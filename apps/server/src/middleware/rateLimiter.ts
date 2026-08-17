import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Caps document create/edit requests at 60 per minute per user, per the
 * spec. Keyed by authenticated userId (falls back to IP pre-auth) so one
 * user hammering the API can't be starved-out or spoofed by IP alone.
 */
export const documentWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anonymous',
  message: { error: 'Too many document writes — limit is 60 per minute.' },
});

/** Looser limit for general read traffic. */
export const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anonymous',
});
