import { Router, type Request } from 'express';
import multer from 'multer';
import { AuthService, requireAuth, readRequestToken } from '@core/auth';
import { FsEngine, type UserFileInfo } from '@core/fs-engine';
import type { ChatEngine } from '@core/chat';
import { asyncRoute } from '../middleware/errorHandler.js';
import { documentWriteLimiter, readLimiter } from '../middleware/rateLimiter.js';
import { hasAccess } from './storage.routes.js';
import { fixUploadName } from '../lib/uploadName.js';

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB per file, same cap as page assets

/** Content-Disposition с исходным (в т.ч. кириллическим) именем — RFC 6266/5987. */
export function contentDisposition(name: string, type: 'inline' | 'attachment'): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Отдаёт файл личного хранилища с правильным типом и именем. */
export function sendUserFile(res: import('express').Response, engine: FsEngine, file: UserFileInfo, download: boolean) {
  const type = file.mimeType || 'application/octet-stream';
  // Текстовые файлы без charset браузер читает как latin1 — кириллица ломается.
  const needsCharset = (type.startsWith('text/') || type === 'application/json') && !/charset=/i.test(type);
  res.setHeader('Content-Type', needsCharset ? `${type}; charset=utf-8` : type);
  res.setHeader('Content-Disposition', contentDisposition(file.originalName, download ? 'attachment' : 'inline'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-cache');
  // Не даём HTML/SVG из чужого файла выполниться в контексте нашего сайта.
  // PDF — без sandbox: в «песочнице» встроенный просмотрщик Chrome не
  // открывается, а сам PDF скрипты в контексте сайта не выполняет.
  const isPdf = file.mimeType === 'application/pdf';
  res.setHeader(
    'Content-Security-Policy',
    isPdf ? "frame-ancestors 'self'" : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
  );
  res.sendFile(engine.getUserFileAbsolutePath(file.ownerId, file.fileName), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

/** Пользователь из Bearer-заголовка или cookie mediaToken, если он есть и валиден; иначе null (без ошибки). */
function optionalUser(auth: AuthService, req: Request): { id: string; role?: string } | null {
  const token = readRequestToken(req);
  if (!token) return null;
  try {
    const p = auth.verifyAccessToken(token);
    return { id: p.sub, role: p.role };
  } catch {
    return null;
  }
}

function accessDeniedPage(message: string, offerLogin: boolean): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Нет доступа</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,sans-serif;background:#f7f7f8;color:#1f2023}
.c{background:#fff;border:1px solid #e6e6ea;border-radius:12px;padding:32px 36px;text-align:center;max-width:360px}
a{display:inline-block;margin-top:16px;background:#5b5bd6;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px}</style></head>
<body><div class="c"><div style="font-size:32px">🔒</div><p>${message}</p>${offerLogin ? '<a href="/">Войти</a>' : ''}</div></body></html>`;
}

/**
 * Может ли этот человек (или аноним, user = null) открыть файл по прямой
 * ссылке /api/files/serve/{ownerId}/{fileName}:
 *   - владелец;
 *   - тот, кому выдан доступ (или всем сотрудникам — '*'), если вошёл;
 *   - текущий аватар владельца — любой вошедший;
 *   - файл вставлен в страницу, которую человек может читать, или в
 *     опубликованную (одобренную) публичную страницу — тогда и аноним;
 *   - файл прикреплён в чате, где человек участник.
 * Без входа и без публикации — никак (раньше хватало ссылки с токеном).
 */
async function canReadUserFile(
  engine: FsEngine,
  chat: ChatEngine,
  user: { id: string; role?: string } | null,
  file: UserFileInfo,
): Promise<boolean> {
  if (user && user.id === file.ownerId) return true;
  // Администратор видит любые файлы — через файловый менеджер в админке.
  if (user?.role === 'Admin') return true;
  if (user && (file.sharedWith.includes(user.id) || file.sharedWith.includes('*'))) return true;
  if (user) {
    const owner = await engine.getUser(file.ownerId).catch(() => null);
    if (owner?.avatarUrl === file.url) return true;
  }

  const refs = await engine.getFileRefs(file.ownerId, file.fileName);
  let publicPages: Set<string> | null = null;
  for (const ref of refs) {
    if (ref.startsWith('page:')) {
      const [ownerId, projectId, pageId] = ref.slice(5).split('/');
      if (!ownerId || !projectId || !pageId) continue;
      if (user) {
        const meta = await engine.getPageMeta(ownerId, projectId, pageId).catch(() => null);
        if (meta && hasAccess(meta.ownerId, user.id, meta.sharing, 'read')) return true;
      }
      if (!publicPages) {
        publicPages = new Set();
        for (const site of await engine.listPublicSites()) {
          if (!site.enabled) continue;
          const full = await engine.getPublicSiteById(site.id).catch(() => null);
          for (const n of full?.nodes ?? []) if (n.status === 'approved') publicPages.add(`${n.ownerId}/${n.projectId}/${n.pageId}`);
        }
      }
      if (publicPages.has(`${ownerId}/${projectId}/${pageId}`)) return true;
    } else if (ref.startsWith('chat:') && user) {
      const summary = await chat.getChatSummary(ref.slice(5)).catch(() => null);
      if (summary?.memberIds.includes(user.id)) return true;
    }
  }
  return false;
}

/**
 * Личное файловое хранилище пользователя: загрузка, список, удаление,
 * выдача доступа другим сотрудникам и публичные ссылки.
 * Backed by `FsEngine.saveUserFile` / `STORAGE_ROOT/users/{userId}/files/`.
 */
export function filesRoutes(auth: AuthService, engine: FsEngine, chat: ChatEngine) {
  const router = Router();

  // Отдача файла по прямой ссылке — проверка прав внутри (canReadUserFile),
  // поэтому до requireAuth: картинки опубликованных страниц видны и без входа.
  router.get(
    '/serve/:userId/:fileName',
    readLimiter,
    asyncRoute(async (req, res) => {
      const file = await engine.getUserFile(req.params.userId!, req.params.fileName!).catch(() => null);
      if (!file) return res.status(404).json({ error: 'Not found' });
      const user = optionalUser(auth, req);
      if (!(await canReadUserFile(engine, chat, user, file))) {
        const status = user ? 403 : 401;
        const message = user ? 'Нет доступа к файлу' : 'Чтобы открыть файл, войдите в систему';
        // Ссылку открыли в браузере (а не <img>/fetch) — понятная страница вместо JSON.
        if (req.accepts(['json', 'html']) === 'html') return res.status(status).type('html').send(accessDeniedPage(message, !user));
        return res.status(status).json({ error: message });
      }
      sendUserFile(res, engine, file, req.query.download === '1');
    }),
  );

  router.use(requireAuth(auth));

  router.get(
    '/',
    readLimiter,
    asyncRoute(async (req, res) => {
      res.json(await engine.listUserFiles(req.user!.id));
    }),
  );

  // Файлы коллег, к которым мне открыт доступ.
  router.get(
    '/shared',
    readLimiter,
    asyncRoute(async (req, res) => {
      res.json(await engine.listFilesSharedWithUser(req.user!.id));
    }),
  );

  router.post(
    '/',
    documentWriteLimiter,
    upload.single('file'),
    asyncRoute(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const info = await engine.saveUserFile(req.user!.id, fixUploadName(req.file.originalname), req.file.buffer, req.file.mimetype);
      res.status(201).json(info);
    }),
  );

  router.delete(
    '/:fileName',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      await engine.deleteUserFile(req.user!.id, req.params.fileName!);
      res.status(204).end();
    }),
  );

  // Кому открыт доступ: { sharedWith: string[] } — id пользователей или '*'.
  router.put(
    '/:fileName/sharing',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { sharedWith } = req.body as { sharedWith?: unknown };
      if (!Array.isArray(sharedWith) || !sharedWith.every((x) => typeof x === 'string')) {
        return res.status(400).json({ error: 'sharedWith must be an array of user ids' });
      }
      try {
        res.json(await engine.setUserFileSharing(req.user!.id, req.params.fileName!, sharedWith as string[]));
      } catch {
        res.status(404).json({ error: 'Not found' });
      }
    }),
  );

  // Публичная ссылка /f/{token}: включить (POST) / отозвать (DELETE).
  router.post(
    '/:fileName/public-link',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      try {
        res.json(await engine.enableUserFilePublicLink(req.user!.id, req.params.fileName!));
      } catch {
        res.status(404).json({ error: 'Not found' });
      }
    }),
  );

  router.delete(
    '/:fileName/public-link',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      try {
        res.json(await engine.disableUserFilePublicLink(req.user!.id, req.params.fileName!));
      } catch {
        res.status(404).json({ error: 'Not found' });
      }
    }),
  );

  return router;
}

/**
 * Публичные ссылки на файлы — без входа. Адрес не раскрывает ни владельца,
 * ни имя файла на диске; отзывается владельцем. Mounted at
 * /api/public-files; снаружи доступен как /f/{token} (rewrite в next.config.js).
 */
export function publicFilesRoutes(engine: FsEngine) {
  const router = Router();
  router.get(
    '/:token',
    readLimiter,
    asyncRoute(async (req, res) => {
      const file = await engine.resolvePublicFileToken(req.params.token!);
      if (!file) return res.status(404).send('Файл не найден или ссылка отозвана');
      res.setHeader('Cache-Control', 'private, no-cache');
      sendUserFile(res, engine, file, req.query.download === '1');
    }),
  );
  return router;
}
