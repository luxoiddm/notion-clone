import { Router } from 'express';
import { AuthService, requireAuth, roleAtLeast } from '@core/auth';
import { ChatEngine, type ChatSummary, type ChatAttachment } from '@core/chat';
import type { FsEngine } from '@core/fs-engine';
import {
  emitChatMessage,
  emitChatMessageUpdated,
  emitChatMessageDeleted,
  emitChatDeleted,
  emitChatThreadCountUpdated,
  emitChatMembersUpdated,
  emitChatNotify,
  removeUserFromChatRoom,
  type RealtimeServer,
} from '@core/realtime';
import { asyncRoute } from '../middleware/errorHandler.js';
import { sanitizeGif } from './gifs.routes.js';
import { readLimiter, documentWriteLimiter } from '../middleware/rateLimiter.js';

// Reasonable default if CHAT_ALLOWED_MIME_TYPES isn't set — images,
// video, PDF, plain text, and the common Office formats. `image/*`-style
// wildcards match any subtype (image/png, image/jpeg, ...).
const DEFAULT_ALLOWED_MIME_TYPES =
  'image/*,video/*,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip';

function getAllowedMimeTypes(): string[] {
  return (process.env.CHAT_ALLOWED_MIME_TYPES ?? DEFAULT_ALLOWED_MIME_TYPES)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Проверяет вложение из тела запроса и оставляет только известные поля.
 * Голосовые и кружки (kind) разрешены всегда — независимо от
 * CHAT_ALLOWED_MIME_TYPES — но только своего типа: audio/* или video/*.
 */
function sanitizeAttachment(raw: unknown): { ok: true; value: ChatAttachment | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'object') return { ok: false, error: 'Некорректное вложение' };
  const a = raw as Record<string, unknown>;
  if (typeof a.url !== 'string' || typeof a.fileName !== 'string' || typeof a.mimeType !== 'string' || typeof a.size !== 'number') {
    return { ok: false, error: 'Некорректное вложение' };
  }
  const mimeType = a.mimeType.split(';')[0]!.trim().toLowerCase();
  const value: ChatAttachment = { url: a.url, fileName: a.fileName, mimeType, size: a.size };
  if (a.kind === 'voice' || a.kind === 'round') {
    const okType = a.kind === 'voice' ? /^(audio\/|video\/(webm|mp4)$)/.test(mimeType) : mimeType.startsWith('video/');
    if (!okType) return { ok: false, error: a.kind === 'voice' ? 'Голосовое должно быть аудиофайлом' : 'Кружок должен быть видеофайлом' };
    value.kind = a.kind;
    const d = Number(a.duration);
    if (Number.isFinite(d) && d > 0) value.duration = Math.min(Math.round(d * 10) / 10, 3600);
    if (a.kind === 'voice' && Array.isArray(a.waveform)) {
      value.waveform = a.waveform
        .slice(0, 64)
        .map((x) => Number(x))
        .map((x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, Math.round(x * 100) / 100)) : 0));
    }
    return { ok: true, value };
  }
  if (!isAttachmentMimeAllowed(mimeType)) return { ok: false, error: `Файлы типа "${mimeType}" нельзя прикреплять в чат` };
  return { ok: true, value };
}

/** Re-read on every call (not cached at module load) so a `.env` edit + process restart always takes effect without anything else to remember. */
function isAttachmentMimeAllowed(mimeType: string): boolean {
  return getAllowedMimeTypes().some((pattern) => {
    if (pattern.endsWith('/*')) return mimeType.startsWith(pattern.slice(0, -1));
    return mimeType === pattern;
  });
}

/**
 * Кто может добавлять и исключать участников: создатель чата, а также
 * Admin и Team-Lead — но только если они сами состоят в этом чате.
 * Выйти из чата (удалить его у себя) может любой участник.
 */
function canManageMembers(summary: ChatSummary, user: { id: string; role: Parameters<typeof roleAtLeast>[0] }): boolean {
  if (!summary.memberIds.includes(user.id)) return false;
  return roleAtLeast(user.role, 'Team-Lead') || (!!summary.createdBy && summary.createdBy === user.id);
}

export function chatRoutes(auth: AuthService, chat: ChatEngine, io: RealtimeServer, fsEngine: FsEngine) {
  const router = Router();
  router.use(requireAuth(auth));

  // Для любого маршрута с :chatId: несуществующий (например, удалённый
  // после выхода последнего участника) чат — 404, а не 500; не участник —
  // 403. Особенно важно теперь, когда из чата можно выйти или быть
  // исключённым: вкладка с открытым чатом может ещё слать запросы.
  router.param('chatId', (req, res, next, chatId: string) => {
    chat
      .getChatSummary(chatId)
      .then((summary) => {
        if (!summary.memberIds.includes(req.user!.id)) {
          res.status(403).json({ error: 'Not a member of this chat' });
          return;
        }
        next();
      })
      .catch(() => {
        res.status(404).json({ error: 'Chat not found' });
      });
  });

  router.get(
    '/',
    readLimiter,
    asyncRoute(async (req, res) => {
      res.json(await chat.listChatsForUser(req.user!.id));
    }),
  );

  router.get(
    '/:chatId',
    readLimiter,
    asyncRoute(async (req, res) => {
      const summary = await chat.getChatSummary(req.params.chatId!);
      if (!summary.memberIds.includes(req.user!.id)) return res.status(403).json({ error: 'Not a member of this chat' });
      res.json(summary);
    }),
  );

  // «Удалить чат у себя» = выйти из него. У остальных участников чат с
  // историей остаётся; когда выходит последний — чат удаляется целиком.
  router.delete(
    '/:chatId',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      try {
        const before = await chat.getChatSummary(req.params.chatId!);
        const after = await chat.removeMember(req.params.chatId!, req.user!.id);
        removeUserFromChatRoom(io, req.user!.id, req.params.chatId!);
        if (after === null) emitChatDeleted(io, req.params.chatId!);
        emitChatMembersUpdated(io, before.memberIds, req.params.chatId!, after?.memberIds ?? []);
        res.status(204).end();
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
    }),
  );

  // Добавить участников. Личный чат при этом становится групповым.
  router.post(
    '/:chatId/members',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { userIds } = req.body as { userIds?: string[] };
      if (!Array.isArray(userIds) || userIds.length === 0 || !userIds.every((id) => typeof id === 'string')) {
        return res.status(400).json({ error: 'userIds must be a non-empty array' });
      }
      let summary: ChatSummary;
      try {
        summary = await chat.getChatSummary(req.params.chatId!);
      } catch {
        return res.status(404).json({ error: 'Chat not found' });
      }
      if (!canManageMembers(summary, req.user!)) {
        return res.status(403).json({ error: 'Добавлять участников может создатель чата, администратор или тимлид — участник этого чата' });
      }
      // Только существующие пользователи — иначе в memberIds попал бы мусор.
      const known = new Set((await fsEngine.listUsers()).filter((u) => !u.dismissedAt).map((u) => u.id));
      const unknown = userIds.filter((id) => !known.has(id));
      if (unknown.length > 0) return res.status(400).json({ error: `Unknown users: ${unknown.join(', ')}` });

      const { summary: updated, added } = await chat.addMembers(req.params.chatId!, userIds);
      if (added.length > 0) emitChatMembersUpdated(io, updated.memberIds, updated.id, updated.memberIds);
      res.json(updated);
    }),
  );

  // Исключить участника (тем же, кто может добавлять). Себя — можно
  // всегда: это то же самое, что выйти из чата.
  router.delete(
    '/:chatId/members/:userId',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      let summary: ChatSummary;
      try {
        summary = await chat.getChatSummary(req.params.chatId!);
      } catch {
        return res.status(404).json({ error: 'Chat not found' });
      }
      const targetId = req.params.userId!;
      if (targetId !== req.user!.id && !canManageMembers(summary, req.user!)) {
        return res.status(403).json({ error: 'Исключать участников может создатель чата, администратор или тимлид — участник этого чата' });
      }
      if (!summary.memberIds.includes(targetId)) return res.status(404).json({ error: 'User is not a member of this chat' });
      const after = await chat.removeMember(summary.id, targetId);
      removeUserFromChatRoom(io, targetId, summary.id);
      if (after === null) emitChatDeleted(io, summary.id);
      emitChatMembersUpdated(io, summary.memberIds, summary.id, after?.memberIds ?? []);
      res.json(after);
    }),
  );

  // Reuses an existing 1-on-1 chat with `otherUserId` if one already
  // exists, instead of creating a new empty one every time — see
  // ChatEngine.getOrCreatePrivateChat for why.
  router.post(
    '/private',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { otherUserId } = req.body as { otherUserId?: string };
      if (!otherUserId) return res.status(400).json({ error: 'otherUserId is required' });
      if (otherUserId === req.user!.id) return res.status(400).json({ error: 'Cannot start a private chat with yourself' });

      const summary = await chat.getOrCreatePrivateChat(req.user!.id, otherUserId);
      emitChatMembersUpdated(io, summary.memberIds, summary.id, summary.memberIds);
      res.status(201).json(summary);
    }),
  );

  router.post(
    '/',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { kind, memberIds, projectId, name } = req.body as {
        kind: 'private' | 'group';
        memberIds: string[];
        projectId?: string;
        name?: string;
      };
      if (!memberIds?.includes(req.user!.id)) {
        return res.status(400).json({ error: 'Caller must be a member of the chat being created' });
      }
      const summary = await chat.createChat({ kind, memberIds, projectId, name, createdBy: req.user!.id });
      emitChatMembersUpdated(io, summary.memberIds, summary.id, summary.memberIds);
      res.status(201).json(summary);
    }),
  );

  router.get(
    '/:chatId/messages',
    readLimiter,
    asyncRoute(async (req, res) => {
      const summary = await chat.getChatSummary(req.params.chatId!);
      if (!summary.memberIds.includes(req.user!.id)) return res.status(403).json({ error: 'Not a member of this chat' });
      const limit = Number(req.query.limit) || 50;
      res.json(await chat.getRecentMessages(req.params.chatId!, limit));
    }),
  );

  router.post(
    '/:chatId/messages',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { text, threadRootId, pageRef, attachment: rawAttachment, gif: rawGif } = req.body as {
        text: string;
        threadRootId?: string | null;
        pageRef?: { ownerId: string; projectId: string; pageId: string } | null;
        attachment?: unknown;
        gif?: unknown;
      };

      // GIF принимается только с CDN поддерживаемых провайдеров (KLIPY/GIPHY).
      const gif = rawGif ? sanitizeGif(rawGif) : null;
      if (rawGif && !gif) return res.status(400).json({ error: 'Некорректный GIF' });

      const checked = sanitizeAttachment(rawAttachment);
      if (!checked.ok) return res.status(400).json({ error: checked.error });
      const attachment = checked.value;

      const message = await chat.sendMessage({
        chatId: req.params.chatId!,
        authorId: req.user!.id,
        text,
        threadRootId,
        pageRef,
        attachment,
        gif,
      });
      emitChatMessage(io, req.params.chatId!, message);
      // Звук нового сообщения у остальных участников — где бы они ни были в приложении.
      void chat
        .getChatSummary(req.params.chatId!)
        .then((summary) =>
          emitChatNotify(io, summary.memberIds, {
            chatId: summary.id,
            messageId: message.id,
            authorId: req.user!.id,
            authorName: req.user!.displayName,
            isThreadReply: !!threadRootId,
          }),
        )
        .catch(() => undefined);
      // Участники чата получают доступ к прикреплённому файлу из личного
      // хранилища автора (см. canReadUserFile в files.routes.ts).
      if (attachment?.url) await fsEngine.addChatFileRef(req.params.chatId!, attachment.url).catch(() => undefined);

      if (threadRootId) {
        const replyCount = await chat.getThreadReplyCount(req.params.chatId!, threadRootId);
        emitChatThreadCountUpdated(io, req.params.chatId!, threadRootId, replyCount);
      }

      res.status(201).json(message);
    }),
  );

  router.patch(
    '/:chatId/messages/:messageId',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { text } = req.body as { text?: string };
      if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

      try {
        const message = await chat.editMessage(req.params.chatId!, req.params.messageId!, req.user!.id, text);
        emitChatMessageUpdated(io, req.params.chatId!, message);
        res.json(message);
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
    }),
  );

  /**
   * После удаления сообщения: если файл больше не прикреплён в этом чате —
   * участники теряют к нему доступ. Голосовое или кружок, записанные прямо
   * в чате, кроме этого удаляются с диска, если файл больше нигде не
   * используется (обычный файл из «Файлов» остаётся у владельца).
   */
  async function releaseAttachment(chatId: string, authorId: string, a: ChatAttachment) {
    if (await chat.chatUsesAttachment(chatId, a.url)) return;
    await fsEngine.removeChatFileRef(chatId, a.url);
    if (a.kind !== 'voice' && a.kind !== 'round') return;
    const m = /\/api\/files\/serve\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9._-]{1,255})/.exec(a.url);
    if (!m || m[1] !== authorId) return;
    if ((await fsEngine.getFileRefs(m[1], m[2]!)).length) return;
    await fsEngine.deleteUserFile(m[1], m[2]!);
  }

  router.delete(
    '/:chatId/messages/:messageId',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      try {
        const result = await chat.deleteMessage(req.params.chatId!, req.params.messageId!, req.user!.id);
        if (result.removedAttachment) {
          await releaseAttachment(req.params.chatId!, req.user!.id, result.removedAttachment).catch((err) =>
            console.warn('[chat] не удалось освободить вложение', err),
          );
        }

        if (result.parentThreadUpdate) {
          emitChatThreadCountUpdated(io, req.params.chatId!, result.parentThreadUpdate.threadRootId, result.parentThreadUpdate.replyCount);
        }

        if (result.message === null) {
          emitChatMessageDeleted(io, req.params.chatId!, req.params.messageId!);
          return res.json({ id: req.params.messageId!, fullyDeleted: true });
        }
        emitChatMessageUpdated(io, req.params.chatId!, result.message);
        res.json(result.message);
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
    }),
  );

  // Toggle, not set — reacting again with the same emoji removes it. Any
  // chat member can react, unlike edit/delete which are author-only, so
  // this doesn't reuse mutationErrorStatus's "author mismatch -> 403"
  // framing beyond what ChatEngine.toggleReaction itself already checks
  // (membership, message not deleted).
  router.post(
    '/:chatId/messages/:messageId/reactions',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { emoji } = req.body as { emoji?: string };
      if (!emoji) return res.status(400).json({ error: 'emoji is required' });

      try {
        const message = await chat.toggleReaction(req.params.chatId!, req.params.messageId!, req.user!.id, emoji);
        emitChatMessageUpdated(io, req.params.chatId!, message);
        res.json(message);
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
    }),
  );

  router.get(
    '/:chatId/threads/:threadRootId',
    readLimiter,
    asyncRoute(async (req, res) => {
      const summary = await chat.getChatSummary(req.params.chatId!);
      if (!summary.memberIds.includes(req.user!.id)) return res.status(403).json({ error: 'Not a member of this chat' });
      res.json(await chat.getThreadReplies(req.params.chatId!, req.params.threadRootId!));
    }),
  );

  return router;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

/**
 * `ChatEngine.editMessage`/`deleteMessage`/`toggleReaction` throw plain
 * `Error`s with descriptive messages rather than typed error codes — this
 * maps them to a status code by message content: "not found" is the only
 * case that isn't really an authorization problem, everything else
 * (wrong author, message already deleted, not a chat member) is a 403.
 */
function mutationErrorStatus(err: unknown): number {
  if (err instanceof Error && err.message.includes('not found')) return 404;
  return 403;
}
