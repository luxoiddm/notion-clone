import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lockManager } from './lockManager.js';

export type ChatKind = 'private' | 'group';

export interface ChatAttachment {
  /** Serve URL — same capability-URL personal-file endpoint the editor already uses for shared-page images (see files.routes.ts). */
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
  /** Голосовое ('voice') или видео-кружок ('round'), записанные прямо в чате. Обычный файл — без поля. */
  kind?: 'voice' | 'round';
  /** Длительность записи в секундах (браузер не всегда пишет её в сам файл). */
  duration?: number;
  /** Форма волны голосового: 0..1, до 64 значений. */
  waveform?: number[];
}

/** GIF из внешнего каталога (KLIPY / GIPHY) — хранится только ссылка на CDN провайдера, сам файл к нам не скачивается. */
export interface ChatGif {
  /** Полноразмерная (средняя) версия для показа в ленте. */
  url: string;
  /** Уменьшенное превью — для списка/медленной сети; может совпадать с url. */
  previewUrl: string;
  width: number;
  height: number;
  title: string;
  provider: 'klipy' | 'giphy';
}

export interface ChatMessage {
  id: string;
  chatId: string;
  authorId: string;
  /** Set when this message is a reply within a thread. */
  threadRootId: string | null;
  text: string;
  /** Optional inline reference to a Knowledge Base page, rendered as a link-preview. */
  pageRef: { ownerId: string; projectId: string; pageId: string } | null;
  /** Optional file/image/video attachment, uploaded to the sender's personal storage — validated against CHAT_ALLOWED_MIME_TYPES at send time (see chat.routes.ts), not here. */
  attachment: ChatAttachment | null;
  /** GIF, отправленный из встроенного поиска (см. /api/gifs). У старых сообщений — null. */
  gif: ChatGif | null;
  createdAt: string;
  /** Set (and updated) only when the author edits the message after sending. */
  editedAt: string | null;
  /**
   * Soft-delete marker. A deleted message keeps its id/authorId/timestamps
   * and stays in the log — `text`/`pageRef`/`reactions` are cleared, but
   * the row itself isn't removed, so thread replies whose `threadRootId`
   * points at it stay valid instead of referencing a message that no
   * longer exists anywhere.
   */
  deletedAt: string | null;
  /** emoji -> ids of users who reacted with it. An emoji key is removed entirely once its list empties out, rather than kept around as `[]`. */
  reactions: Record<string, string[]>;
}

/**
 * What `getRecentMessages` actually returns — not part of `ChatMessage`
 * itself (that's the stored/wire shape used everywhere else, including
 * realtime events for a single message) because `replyCount` isn't
 * stored on the message at all, it's computed fresh on every list read
 * from messages already loaded into memory for the top-level filter —
 * cheap to add there, not worth threading through every other method
 * that returns a single `ChatMessage`.
 */
export interface ChatMessageWithReplyCount extends ChatMessage {
  replyCount: number;
}

/** Return shape for deleteMessage — see the field comments for why this needs to be more than just the ChatMessage | null it used to be. */
export interface DeleteMessageResult {
  /** null = fully removed; a ChatMessage = soft-deleted (kept as a "Сообщение удалено" placeholder) — same meaning as deleteMessage's old return value. */
  message: ChatMessage | null;
  /** Set only if the deleted message was itself a thread reply — its parent's reply count just changed, so the caller (the route) knows to broadcast that update. null when a top-level message was deleted (nothing else to notify about). */
  parentThreadUpdate: { threadRootId: string; replyCount: number } | null;
  /** Вложение удалённого сообщения (если было) — чтобы маршрут убрал ссылку на файл, а голосовое/кружок удалил с диска. */
  removedAttachment: ChatAttachment | null;
}

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  /** For private chats: exactly two user IDs. For group: any size, tied to a project. */
  memberIds: string[];
  projectId: string | null;
  name: string | null;
  createdAt: string;
  /**
   * Кто создал чат — вместе с Admin/Team-Lead (если они участники) может
   * добавлять и исключать участников. `null` у чатов, созданных до
   * появления этого поля: ими управляют только Admin/Team-Lead-участники.
   */
  createdBy?: string | null;
  /** Кто вышел из чата (или был исключён) — только для подписи в интерфейсе («собеседник покинул чат»). */
  leftMemberIds?: string[];
}

/** A chat plus its most recent message, for list/preview views. */
export interface ChatListItem extends ChatSummary {
  lastMessage: ChatMessage | null;
}

/**
 * Messages live in JSONL files, one line per message.
 *
 *   /storage/chats/private/{chatId}.jsonl
 *   /storage/chats/group/{chatId}.jsonl
 *   /storage/chats/{chatId}.meta.json
 *
 * New messages are still appended (cheap, no read-modify-write). Editing,
 * deleting, and reacting to an *existing* message are inherently
 * read-modify-write, though — read the whole file, replace one line,
 * write the whole file back (temp file + rename, same atomic-write
 * pattern `@core/fs-engine` uses for meta.json). Every one of these
 * operations — including the plain append in `sendMessage` — goes through
 * `lockManager` keyed on the chat's file path, so an edit/delete/reaction
 * rewriting the file can never race with (and silently drop) a message
 * someone else sent in the same moment.
 */
export class ChatEngine {
  private readonly root: string;

  constructor(storageRoot: string) {
    this.root = path.resolve(storageRoot, 'chats');
  }

  private chatFile(kind: ChatKind, chatId: string): string {
    return path.join(this.root, kind, `${chatId}.jsonl`);
  }

  private metaFile(chatId: string): string {
    return path.join(this.root, `${chatId}.meta.json`);
  }

  async createChat(input: {
    kind: ChatKind;
    memberIds: string[];
    projectId?: string | null;
    name?: string | null;
    createdBy?: string | null;
  }): Promise<ChatSummary> {
    const id = randomUUID();
    await fs.mkdir(path.join(this.root, input.kind), { recursive: true });

    const summary: ChatSummary = {
      id,
      kind: input.kind,
      memberIds: input.memberIds,
      projectId: input.projectId ?? null,
      name: input.name ?? null,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? null,
      leftMemberIds: [],
    };

    await fs.writeFile(this.metaFile(id), JSON.stringify(summary, null, 2), 'utf-8');
    await fs.writeFile(this.chatFile(input.kind, id), '', 'utf-8');
    return summary;
  }

  async getChatSummary(chatId: string): Promise<ChatSummary> {
    let raw: string;
    try {
      raw = await fs.readFile(this.metaFile(chatId), 'utf-8');
    } catch (err) {
      // Чат удалён (последний участник вышел) — понятная ошибка вместо
      // сырого ENOENT, роуты переводят её в 404.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Chat ${chatId} not found`);
      throw err;
    }
    return JSON.parse(raw) as ChatSummary;
  }

  /** Удаляет чат целиком — метаданные и все сообщения. Вызывается, когда из чата вышел последний участник. */
  private async destroyChat(summary: ChatSummary): Promise<void> {
    const filePath = this.chatFile(summary.kind, summary.id);
    await lockManager.run(filePath, async () => {
      await fs.rm(this.metaFile(summary.id), { force: true });
      await fs.rm(filePath, { force: true });
    });
  }

  private async writeMetaAtomic(summary: ChatSummary): Promise<void> {
    const target = this.metaFile(summary.id);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(summary, null, 2), 'utf-8');
    await fs.rename(tmp, target);
  }

  /**
   * Добавляет участников. Если чат был личным (`private`), он становится
   * групповым: меняется `kind`, и файл сообщений переезжает из
   * `private/` в `group/` (история сохраняется). Уже состоящих в чате
   * пропускает; возвращает обновлённое описание чата.
   */
  async addMembers(chatId: string, userIds: string[]): Promise<{ summary: ChatSummary; added: string[] }> {
    return lockManager.run(this.metaFile(chatId), async () => {
      const summary = await this.getChatSummary(chatId);
      const added = [...new Set(userIds)].filter((id) => !summary.memberIds.includes(id));
      if (added.length === 0) return { summary, added };

      const next: ChatSummary = {
        ...summary,
        memberIds: [...summary.memberIds, ...added],
        leftMemberIds: (summary.leftMemberIds ?? []).filter((id) => !added.includes(id)),
      };

      if (summary.kind === 'private') {
        next.kind = 'group';
        const from = this.chatFile('private', chatId);
        const to = this.chatFile('group', chatId);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await lockManager.run(from, async () => {
          await fs.rename(from, to).catch(async (err: NodeJS.ErrnoException) => {
            // Файла сообщений могло ещё не быть — тогда просто создаём пустой.
            if (err.code === 'ENOENT') await fs.writeFile(to, '', 'utf-8');
            else throw err;
          });
        });
      }

      await this.writeMetaAtomic(next);
      return { summary: next, added };
    });
  }

  /**
   * Убирает участника из чата — и когда он выходит сам (удаляет чат у
   * себя), и когда его исключают. Чат у остальных остаётся с историей;
   * если участников не осталось, чат удаляется целиком.
   * Возвращает обновлённое описание или `null`, если чат удалён.
   */
  async removeMember(chatId: string, userId: string): Promise<ChatSummary | null> {
    const result = await lockManager.run(this.metaFile(chatId), async () => {
      const summary = await this.getChatSummary(chatId);
      if (!summary.memberIds.includes(userId)) {
        throw new Error(`User ${userId} is not a member of chat ${chatId}`);
      }
      const next: ChatSummary = {
        ...summary,
        memberIds: summary.memberIds.filter((id) => id !== userId),
        leftMemberIds: [...new Set([...(summary.leftMemberIds ?? []), userId])],
      };
      if (next.memberIds.length === 0) return { next, destroy: true };
      await this.writeMetaAtomic(next);
      return { next, destroy: false };
    });
    if (result.destroy) {
      await this.destroyChat(result.next);
      return null;
    }
    return result.next;
  }

  /**
   * Lists every chat `userId` belongs to, each with its most recent
   * message for preview/sorting. Scans all `*.meta.json` files under the
   * chats root (flat, not indexed) — same tradeoff as
   * `FsEngine.listSharedPages`: fine at team scale, would need a real
   * index if the number of chats ever got large.
   */
  async listChatsForUser(userId: string): Promise<ChatListItem[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch {
      return [];
    }

    const summaries: ChatSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue;
      try {
        const raw = await fs.readFile(path.join(this.root, entry), 'utf-8');
        const summary = JSON.parse(raw) as ChatSummary;
        if (summary.memberIds.includes(userId)) summaries.push(summary);
      } catch {
        // Skip a corrupted/partial meta file rather than failing the whole listing.
      }
    }

    const withLastMessage = await Promise.all(
      summaries.map(async (summary): Promise<ChatListItem> => {
        const recent = await this.getRecentMessages(summary.id, 1);
        return { ...summary, lastMessage: recent[recent.length - 1] ?? null };
      }),
    );

    withLastMessage.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt ?? a.createdAt;
      const bTime = b.lastMessage?.createdAt ?? b.createdAt;
      return bTime.localeCompare(aTime); // newest activity first
    });

    return withLastMessage;
  }

  /**
   * Файл переехал (админ перенёс его в каталог другого пользователя) —
   * меняет адрес вложения во всех сообщениях чата. Возвращает изменённые
   * сообщения (чтобы разослать их участникам как 'chat:message-updated').
   */
  async replaceAttachmentUrl(chatId: string, oldUrl: string, newUrl: string): Promise<ChatMessage[]> {
    const summary = await this.getChatSummary(chatId);
    const filePath = this.chatFile(summary.kind, summary.id);
    return lockManager.run(filePath, async () => {
      const messages = await this.readAllRaw(filePath);
      const changed: ChatMessage[] = [];
      const next = messages.map((m) => {
        if (m.attachment?.url !== oldUrl) return m;
        const updated = { ...m, attachment: { ...m.attachment, url: newUrl } };
        changed.push(updated);
        return updated;
      });
      if (changed.length) await this.writeAllAtomic(filePath, next);
      return changed;
    });
  }

  /**
   * Страница переехала к другому владельцу (админ) — обновляет ссылки на
   * неё (`pageRef`) во всех чатах. `moves`: старый ключ owner/project/page →
   * новые ownerId/projectId. Возвращает изменённые сообщения по чатам.
   */
  async replacePageRefs(moves: Map<string, { ownerId: string; projectId: string }>): Promise<{ chatId: string; messages: ChatMessage[] }[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch {
      return [];
    }
    const out: { chatId: string; messages: ChatMessage[] }[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue;
      let summary: ChatSummary;
      try {
        summary = JSON.parse(await fs.readFile(path.join(this.root, entry), 'utf-8')) as ChatSummary;
      } catch {
        continue;
      }
      const filePath = this.chatFile(summary.kind, summary.id);
      const changed = await lockManager.run(filePath, async () => {
        const messages = await this.readAllRaw(filePath);
        const upd: ChatMessage[] = [];
        const next = messages.map((m) => {
          const r = m.pageRef;
          const to = r ? moves.get(`${r.ownerId}/${r.projectId}/${r.pageId}`) : undefined;
          if (!r || !to) return m;
          const u = { ...m, pageRef: { ownerId: to.ownerId, projectId: to.projectId, pageId: r.pageId } };
          upd.push(u);
          return u;
        });
        if (upd.length) await this.writeAllAtomic(filePath, next);
        return upd;
      });
      if (changed.length) out.push({ chatId: summary.id, messages: changed });
    }
    return out;
  }

  /** Все вложения во всех чатах (для однократного построения индекса использования файлов). */
  /** Есть ли ещё в чате сообщение с этим вложением (один файл можно прикрепить несколько раз). */
  async chatUsesAttachment(chatId: string, url: string): Promise<boolean> {
    const summary = await this.getChatSummary(chatId);
    return (await this.readAll(summary)).some((m) => m.attachment?.url === url);
  }

  async listAllAttachments(): Promise<{ chatId: string; url: string }[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch {
      return [];
    }
    const out: { chatId: string; url: string }[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue;
      try {
        const summary = JSON.parse(await fs.readFile(path.join(this.root, entry), 'utf-8')) as ChatSummary;
        for (const m of await this.readAll(summary)) if (m.attachment?.url) out.push({ chatId: summary.id, url: m.attachment.url });
      } catch {
        /* битый чат — пропускаем */
      }
    }
    return out;
  }

  /**
   * Finds an existing private (1-on-1) chat between these two users, or
   * creates one. Without this, clicking "message" on the same person
   * twice would spawn a new empty chat each time instead of reopening the
   * existing conversation.
   */
  async getOrCreatePrivateChat(userAId: string, userBId: string): Promise<ChatSummary> {
    const mine = await this.listChatsForUser(userAId);
    const existing = mine.find((c) => c.kind === 'private' && c.memberIds.length === 2 && c.memberIds.includes(userBId));
    if (existing) return existing;
    return this.createChat({ kind: 'private', memberIds: [userAId, userBId], createdBy: userAId });
  }

  async sendMessage(input: {
    chatId: string;
    authorId: string;
    text: string;
    threadRootId?: string | null;
    pageRef?: { ownerId: string; projectId: string; pageId: string } | null;
    attachment?: ChatAttachment | null;
    gif?: ChatGif | null;
  }): Promise<ChatMessage> {
    const summary = await this.getChatSummary(input.chatId);
    if (!summary.memberIds.includes(input.authorId)) {
      throw new Error(`User ${input.authorId} is not a member of chat ${input.chatId}`);
    }

    const message: ChatMessage = {
      id: randomUUID(),
      chatId: input.chatId,
      authorId: input.authorId,
      threadRootId: input.threadRootId ?? null,
      text: input.text,
      pageRef: input.pageRef ?? null,
      attachment: input.attachment ?? null,
      gif: input.gif ?? null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      reactions: {},
    };

    const filePath = this.chatFile(summary.kind, summary.id);
    await lockManager.run(filePath, async () => {
      await fs.appendFile(filePath, JSON.stringify(message) + '\n', 'utf-8');
    });
    return message;
  }

  /**
   * Only the author may edit their own message, and only while it hasn't
   * been deleted. Throws (caller maps this to 403/404) rather than
   * silently no-op-ing, so a route can't accidentally report success for
   * an edit that didn't happen.
   */
  async editMessage(chatId: string, messageId: string, authorId: string, text: string): Promise<ChatMessage> {
    const summary = await this.getChatSummary(chatId);
    const filePath = this.chatFile(summary.kind, summary.id);

    return lockManager.run(filePath, async () => {
      const messages = await this.readAllRaw(filePath);
      const idx = messages.findIndex((m) => m.id === messageId);
      const target = messages[idx];
      if (idx === -1 || !target) throw new Error(`Message ${messageId} not found`);
      if (target.authorId !== authorId) throw new Error('Only the author can edit this message');
      if (target.deletedAt) throw new Error('Cannot edit a deleted message');

      const updated: ChatMessage = { ...target, text, editedAt: new Date().toISOString() };
      messages[idx] = updated;
      await this.writeAllAtomic(filePath, messages);
      return updated;
    });
  }

  /**
   * Soft delete — only the author may delete their own message. Clears
   * `text`/`pageRef`/`reactions` but keeps the row (see the `deletedAt`
   * doc comment on ChatMessage for why).
   */
  /**
   * Deletes a message — genuinely removes the row in the common case
   * (nothing else in the chat references it), returning `null` to tell
   * the caller "it's gone, not just marked". Only falls back to the old
   * soft-delete behavior (keep the row, clear its content, set
   * `deletedAt`) when the message has existing thread replies — removing
   * it outright would leave those replies pointing at a `threadRootId`
   * that no longer exists anywhere, and with no way left to reach them
   * through the UI at all (the thread toggle lives on the root message).
   * A message with no replies has nothing to protect, so it's just gone.
   */
  /**
   * Only the author may delete their own message. Removal is genuine
   * (the row is gone, not just marked) unless the message has existing
   * thread replies — see the `deletedAt` doc comment on `ChatMessage`
   * for why that specific case falls back to a soft-delete placeholder
   * instead. `parentThreadUpdate` in the result tells the caller whether
   * a *parent* message's reply count just changed (only possible when
   * the deleted message was itself a reply — a message with its own
   * replies is by definition a thread root, which can't also be a reply
   * to something else in this flat, non-nested threading model).
   */
  async deleteMessage(chatId: string, messageId: string, authorId: string): Promise<DeleteMessageResult> {
    const summary = await this.getChatSummary(chatId);
    const filePath = this.chatFile(summary.kind, summary.id);

    return lockManager.run(filePath, async () => {
      const messages = await this.readAllRaw(filePath);
      const idx = messages.findIndex((m) => m.id === messageId);
      const target = messages[idx];
      if (idx === -1 || !target) throw new Error(`Message ${messageId} not found`);
      if (target.authorId !== authorId) throw new Error('Only the author can delete this message');

      const hasReplies = messages.some((m) => m.threadRootId === messageId);
      if (!hasReplies) {
        messages.splice(idx, 1);
        await this.writeAllAtomic(filePath, messages);
        const parentThreadUpdate = target.threadRootId
          ? { threadRootId: target.threadRootId, replyCount: messages.filter((m) => m.threadRootId === target.threadRootId).length }
          : null;
        return { message: null, parentThreadUpdate, removedAttachment: target.attachment ?? null };
      }

      const updated: ChatMessage = {
        ...target,
        text: '',
        pageRef: null,
        gif: null,
        attachment: null,
        reactions: {},
        deletedAt: new Date().toISOString(),
      };
      messages[idx] = updated;
      await this.writeAllAtomic(filePath, messages);
      return { message: updated, parentThreadUpdate: null, removedAttachment: target.attachment ?? null };
    });
  }

  /**
   * Adding a reaction you've already left removes it (toggle), matching
   * how every chat app's emoji-reaction picker behaves. Any *member* of
   * the chat can react — unlike edit/delete, this isn't restricted to the
   * message's author.
   */
  async toggleReaction(chatId: string, messageId: string, userId: string, emoji: string): Promise<ChatMessage> {
    const summary = await this.getChatSummary(chatId);
    if (!summary.memberIds.includes(userId)) {
      throw new Error(`User ${userId} is not a member of chat ${chatId}`);
    }
    const filePath = this.chatFile(summary.kind, summary.id);

    return lockManager.run(filePath, async () => {
      const messages = await this.readAllRaw(filePath);
      const idx = messages.findIndex((m) => m.id === messageId);
      const target = messages[idx];
      if (idx === -1 || !target) throw new Error(`Message ${messageId} not found`);
      if (target.deletedAt) throw new Error('Cannot react to a deleted message');

      const current = target.reactions[emoji] ?? [];
      const alreadyReacted = current.includes(userId);
      const nextUsers = alreadyReacted ? current.filter((id) => id !== userId) : [...current, userId];

      const nextReactions = { ...target.reactions };
      if (nextUsers.length > 0) nextReactions[emoji] = nextUsers;
      else delete nextReactions[emoji];

      const updated: ChatMessage = { ...target, reactions: nextReactions };
      messages[idx] = updated;
      await this.writeAllAtomic(filePath, messages);
      return updated;
    });
  }

  /** Returns the most recent `limit` top-level messages (thread replies excluded), oldest first — each with `replyCount` computed fresh from the same in-memory read, not stored anywhere. */
  async getRecentMessages(chatId: string, limit = 50): Promise<ChatMessageWithReplyCount[]> {
    const summary = await this.getChatSummary(chatId);
    const all = await this.readAll(summary);
    const topLevel = all.filter((m) => m.threadRootId === null);
    const recent = topLevel.slice(-limit);
    return recent.map((m) => ({ ...m, replyCount: all.filter((r) => r.threadRootId === m.id).length }));
  }

  async getThreadReplies(chatId: string, threadRootId: string): Promise<ChatMessage[]> {
    const summary = await this.getChatSummary(chatId);
    const all = await this.readAll(summary);
    return all.filter((m) => m.threadRootId === threadRootId);
  }

  /** Lighter than getThreadReplies when only the count is needed (e.g. after sending a reply, to broadcast the parent's updated badge) — same underlying read, just doesn't bother returning the full reply objects. */
  async getThreadReplyCount(chatId: string, threadRootId: string): Promise<number> {
    const summary = await this.getChatSummary(chatId);
    const all = await this.readAll(summary);
    return all.filter((m) => m.threadRootId === threadRootId).length;
  }

  private async readAll(summary: ChatSummary): Promise<ChatMessage[]> {
    return this.readAllRaw(this.chatFile(summary.kind, summary.id));
  }

  private async readAllRaw(filePath: string): Promise<ChatMessage[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => normalizeMessage(JSON.parse(line) as Partial<ChatMessage>));
    } catch {
      return [];
    }
  }

  private async writeAllAtomic(filePath: string, messages: ChatMessage[]): Promise<void> {
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    const content = messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length > 0 ? '\n' : '');
    try {
      await fs.writeFile(tmpPath, content, 'utf-8');
      await fs.rename(tmpPath, filePath); // atomic on the same filesystem
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }
  }
}

/**
 * Fills in defaults for fields that didn't exist yet when older messages
 * were written — `editedAt`/`deletedAt`/`reactions` were added after
 * `sendMessage` had already been appending messages without them for a
 * while. `JSON.parse(line) as ChatMessage` is only a compile-time
 * assertion; it does nothing to guarantee those keys actually exist in
 * data written before this shape existed, and reading them as `undefined`
 * downstream broke `Object.entries(message.reactions)` in the chat UI
 * with "Cannot convert undefined or null to object". Every read goes
 * through here (not just a one-off migration script), so this stays
 * correct even for files nobody's gotten around to migrating.
 */
function normalizeMessage(raw: Partial<ChatMessage>): ChatMessage {
  return {
    id: raw.id ?? '',
    chatId: raw.chatId ?? '',
    authorId: raw.authorId ?? '',
    threadRootId: raw.threadRootId ?? null,
    text: raw.text ?? '',
    pageRef: raw.pageRef ?? null,
    attachment: raw.attachment ?? null,
    gif: raw.gif ?? null,
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    editedAt: raw.editedAt ?? null,
    deletedAt: raw.deletedAt ?? null,
    reactions: raw.reactions ?? {},
  };
}
