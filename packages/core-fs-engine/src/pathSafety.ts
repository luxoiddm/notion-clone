import path from 'node:path';
import { FsEngineError } from './types.js';

/**
 * Every path the engine touches MUST be produced by joinSafe() below.
 * We never interpolate raw user input directly into a path string —
 * every dynamic path segment is validated against SAFE_ID first, and the
 * final resolved path is re-checked to make sure it never escapes `root`.
 */
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function assertSafeId(id: string, label = 'id'): string {
  if (!SAFE_ID.test(id)) {
    throw new FsEngineError(`Invalid ${label}: "${id}"`, 'INVALID_INPUT');
  }
  return id;
}

/**
 * Joins path segments under `root`, guaranteeing the resolved path can
 * never escape `root` (blocks "../", absolute-path injection, symlink
 * tricks are handled separately by the caller resolving realpath when needed).
 */
export function joinSafe(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, ...segments);

  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    throw new FsEngineError(
      `Path traversal blocked: "${segments.join('/')}" escapes storage root`,
      'FORBIDDEN_PATH',
    );
  }

  return resolvedTarget;
}

/** Sanitizes a user-supplied file name (uploads) without allowing directory components. */
export function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).trim();
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new FsEngineError(`Invalid file name: "${fileName}"`, 'INVALID_INPUT');
  }
  return cleaned;
}
