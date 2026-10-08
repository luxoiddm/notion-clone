import { Router } from 'express';
import { AuthService, requireAuth, requireRole } from '@core/auth';
import { FsEngine } from '@core/fs-engine';
import type { ChatEngine } from '@core/chat';
import { emitChatMessageUpdated, type RealtimeServer } from '@core/realtime';
import { asyncRoute } from '../middleware/errorHandler.js';
import { documentWriteLimiter, readLimiter } from '../middleware/rateLimiter.js';

/**
 * Файловый менеджер администратора: кто сколько места занимает, файлы и
 * документы каждого пользователя (в т.ч. уволенных — их папки лежат в
 * STORAGE_ROOT/dismissed/), скачивание, удаление и перенос файлов между
 * каталогами с обновлением всех ссылок. Только Admin.
 * Mounted at /api/admin/storage.
 */
export function adminStorageRoutes(auth: AuthService, engine: FsEngine, chat: ChatEngine, io: RealtimeServer) {
  const router = Router();
  router.use(requireAuth(auth), requireRole('Admin'));

  // Таблица пользователей с занимаемым местом.
  router.get(
    '/users',
    readLimiter,
    asyncRoute(async (_req, res) => {
      const [users, credentials] = await Promise.all([engine.listUsers(), engine.getAllCredentials()]);
      const emailById = new Map<string, string>();
      for (const [email, c] of Object.entries(credentials)) emailById.set(c.userId, email);
      const rows = await Promise.all(
        users.map(async (u) => ({
          id: u.id,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl,
          role: u.role,
          enabled: u.enabled,
          dismissedAt: u.dismissedAt ?? null,
          email: emailById.get(u.id) ?? null,
          ...(await engine.getUserStorageSummary(u.id)),
        })),
      );
      rows.sort((a, b) => b.totalBytes - a.totalBytes);
      res.json(rows);
    }),
  );

  // Файлы пользователя + где каждый используется.
  router.get(
    '/users/:userId/files',
    readLimiter,
    asyncRoute(async (req, res) => {
      const userId = req.params.userId!;
      const files = await engine.listUserFiles(userId);
      const withUsage = await Promise.all(
        files.map(async (f) => {
          const refs = await engine.getFileRefs(userId, f.fileName);
          return {
            ...f,
            usage: { pages: refs.filter((r) => r.startsWith('page:')).length, chats: refs.filter((r) => r.startsWith('chat:')).length },
          };
        }),
      );
      res.json(withUsage);
    }),
  );

  router.delete(
    '/users/:userId/files/:fileName',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      await engine.deleteUserFile(req.params.userId!, req.params.fileName!);
      res.status(204).end();
    }),
  );

  // Перенос файла в каталог другого пользователя: { toUserId }.
  router.post(
    '/users/:userId/files/:fileName/move',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { toUserId } = req.body as { toUserId?: string };
      if (!toUserId || typeof toUserId !== 'string') return res.status(400).json({ error: 'toUserId is required' });
      const result = await engine.moveUserFile(req.params.userId!, req.params.fileName!, toUserId, req.user!.id);
      // Вложения в чатах — новые адреса, и сразу всем, у кого чат открыт.
      for (const chatId of result.chatIds) {
        const changed = await chat.replaceAttachmentUrl(chatId, result.oldUrl, result.newUrl).catch(() => []);
        for (const m of changed) emitChatMessageUpdated(io, chatId, m);
      }
      res.json(result.file);
    }),
  );

  // Документы пользователя плоским списком.
  router.get(
    '/users/:userId/pages',
    readLimiter,
    asyncRoute(async (req, res) => {
      res.json(await engine.listUserPagesFlat(req.params.userId!));
    }),
  );

  // Перенос документа (с вложенными страницами) другому пользователю:
  // { toUserId, toProjectId?, withFiles? }. Ссылки в документах, публикациях
  // и чатах обновляются.
  router.post(
    '/users/:userId/pages/:projectId/:pageId/move',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { toUserId, toProjectId, withFiles } = req.body as { toUserId?: string; toProjectId?: string | null; withFiles?: boolean };
      if (!toUserId || typeof toUserId !== 'string') return res.status(400).json({ error: 'toUserId is required' });
      const result = await engine.movePages({
        fromUserId: req.params.userId!,
        projectId: req.params.projectId!,
        pageId: req.params.pageId!,
        toUserId,
        toProjectId: toProjectId ?? null,
        actorId: req.user!.id,
        withFiles: withFiles !== false,
      });
      for (const { chatId, messages } of await chat.replacePageRefs(result.pageMoves).catch(() => [])) {
        for (const m of messages) emitChatMessageUpdated(io, chatId, m);
      }
      for (const fm of result.fileMoves) {
        for (const chatId of fm.chatIds) {
          const changed = await chat.replaceAttachmentUrl(chatId, fm.oldUrl, fm.newUrl).catch(() => []);
          for (const m of changed) emitChatMessageUpdated(io, chatId, m);
        }
      }
      res.json({ movedPages: result.movedIds.length, movedFiles: result.fileMoves.length, toProjectId: result.toProjectId });
    }),
  );

  router.delete(
    '/users/:userId/pages/:projectId/:pageId',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      await engine.deletePage(req.params.userId!, req.params.projectId!, req.params.pageId!);
      res.status(204).end();
    }),
  );

  return router;
}
