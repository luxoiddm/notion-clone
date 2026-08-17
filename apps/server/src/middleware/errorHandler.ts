import type { NextFunction, Request, Response } from 'express';
import { FsEngineError } from '@core/fs-engine';

const STATUS_BY_CODE: Record<FsEngineError['code'], number> = {
  NOT_FOUND: 404,
  FORBIDDEN_PATH: 403,
  ALREADY_EXISTS: 409,
  INVALID_INPUT: 400,
  IO_ERROR: 500,
  LOCK_TIMEOUT: 503,
};

/**
 * Single place all unhandled route errors funnel through. Filesystem
 * errors are logged with their full stack (and the FsEngineError.cause,
 * which usually holds the underlying Node errno) so on-disk problems are
 * always traceable, while the client only ever gets a safe message.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof FsEngineError) {
    console.error(`[fs-engine] ${err.code} on ${req.method} ${req.originalUrl}: ${err.message}`, err.cause ?? '');
    return res.status(STATUS_BY_CODE[err.code]).json({ error: err.message, code: err.code });
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`[unhandled] ${req.method} ${req.originalUrl}: ${message}\n${stack ?? ''}`);

  return res.status(500).json({ error: 'Internal server error' });
}

/** Wraps an async route handler so rejected promises reach errorHandler instead of hanging the request. */
export function asyncRoute<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
