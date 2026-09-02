import { Router } from 'express';
import { AuthService, requireAuth } from '@core/auth';
import { ChatEngine } from '@core/chat';
import {
  emitChatMessage,
  emitChatMessageUpdated,
  emitChatMessageDeleted,
  emitChatDeleted,
  emitChatThreadCountUpdated,
  type RealtimeServer,
} from '@core/realtime';
import { asyncRoute } from '../middleware/errorHandler.js';
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

/** Re-read on every call (not cached at module load) so a `.env` edit + process restart always takes effect without anything else to remember. */
function isAttachmentMimeAllowed(mimeType: string): boolean {
  return getAllowedMimeTypes().some((pattern) => {
    if (pattern.endsWith('/*')) return mimeType.startsWith(pattern.slice(0, -1));
    return mimeType === pattern;
  });
}

export function chatRoutes(auth: AuthService, chat: ChatEngine, io: RealtimeServer) {
  const router = Router();
  router.use(requireAuth(auth));

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

  // Removes the chat entirely, for every member — see ChatEngine.deleteChat
  // for why there's no separate "leave without deleting for others".
  router.delete(
    '/:chatId',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      try {
        await chat.deleteChat(req.params.chatId!, req.user!.id);
        emitChatDeleted(io, req.params.chatId!);
        res.status(204).end();
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
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
      const summary = await chat.createChat({ kind, memberIds, projectId, name });
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
      const { text, threadRootId, pageRef, attachment } = req.body as {
        text: string;
        threadRootId?: string | null;
        pageRef?: { ownerId: string; projectId: string; pageId: string } | null;
        attachment?: { url: string; fileName: string; mimeType: string; size: number } | null;
      };

      if (attachment && !isAttachmentMimeAllowed(attachment.mimeType)) {
        return res.status(400).json({ error: `Файлы типа "${attachment.mimeType}" нельзя прикреплять в чат` });
      }

      const message = await chat.sendMessage({
        chatId: req.params.chatId!,
        authorId: req.user!.id,
        text,
        threadRootId,
        pageRef,
        attachment,
      });
      emitChatMessage(io, req.params.chatId!, message);

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

  router.delete(
    '/:chatId/messages/:messageId',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      try {
        const result = await chat.deleteMessage(req.params.chatId!, req.params.messageId!, req.user!.id);

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
