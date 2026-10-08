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

/**
 * Человекочитаемое имя файла для показа и скачивания (Content-Disposition):
 * сохраняет кириллицу и любые буквы Unicode, но убирает путь, управляющие
 * символы и символы, запрещённые в именах файлов Windows. На диск под этим
 * именем ничего не пишется — имя на диске всегда ASCII (см. sanitizeFileName).
 */
export function sanitizeDisplayFileName(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
}

/** Расширение файла в безопасном ASCII-виде (`.pdf`), или пустая строка. */
export function safeExtension(fileName: string): string {
  const m = /\.([a-zA-Z0-9]{1,10})$/.exec(fileName.trim());
  return m ? `.${m[1]!.toLowerCase()}` : '';
}
