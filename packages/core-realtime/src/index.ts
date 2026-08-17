import type { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import type { ChatMessage } from '@core/chat';

export interface RealtimeUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CursorPosition {
  blockId: string;
  offset: number;
}

interface ClientToServerEvents {
  'page:join': (payload: { projectId: string; pageId: string }) => void;
  'page:leave': (payload: { projectId: string; pageId: string }) => void;
  'page:cursor': (payload: { projectId: string; pageId: string; cursor: CursorPosition }) => void;
  'page:patch': (payload: { projectId: string; pageId: string; blocks: unknown }) => void;
  /** `ack` reports whether membership was verified — a rejected join never actually joins the room. */
  'chat:join': (payload: { chatId: string }, ack?: (ok: boolean) => void) => void;
  'chat:leave': (payload: { chatId: string }) => void;
  'chat:typing': (payload: { chatId: string; isTyping: boolean }) => void;
}

interface ServerToClientEvents {
  'presence:update': (payload: { pageId: string; users: RealtimeUser[] }) => void;
  'page:cursor': (payload: { userId: string; cursor: CursorPosition }) => void;
  'page:patch': (payload: { userId: string; blocks: unknown }) => void;
  /** Emitted by the server itself right after a message is durably saved — see emitChatMessage(). */
  'chat:message': (message: ChatMessage) => void;
  /** Emitted after an existing message is edited, (soft-)deleted, or reacted to — the client should replace its local copy by id, not append (see emitChatMessageUpdated()). */
  'chat:message-updated': (message: ChatMessage) => void;
  /** Emitted when a message is fully removed (not soft-deleted — see ChatEngine.deleteMessage) — the client should remove it from local state entirely, not replace it with a "deleted" placeholder. */
  'chat:message-deleted': (payload: { chatId: string; messageId: string }) => void;
  /** Emitted when the whole chat is deleted (not a single message) — the client should remove it from its chat list and close the window if it was open. */
  'chat:deleted': (payload: { chatId: string }) => void;
  /** Emitted whenever a thread's reply count changes (a reply sent or a reply deleted) — the client should update that root message's badge without needing to re-fetch or open the thread. */
  'chat:thread-count-updated': (payload: { chatId: string; threadRootId: string; replyCount: number }) => void;
  'chat:typing': (payload: { chatId: string; userId: string; isTyping: boolean }) => void;
}

interface SocketData {
  user: RealtimeUser;
}

export type RealtimeServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

function pageRoomKey(projectId: string, pageId: string): string {
  return `page:${projectId}:${pageId}`;
}

function chatRoomKey(chatId: string): string {
  return `chat:${chatId}`;
}

/**
 * Every user's own room, joined automatically on connect — lets other
 * server-side code (right now: `@core/webrtc`'s incoming-call broadcast)
 * reach a specific user regardless of which page/chat they currently have
 * open, without needing to track userId → socketId mappings itself.
 */
export function personalRoomKey(userId: string): string {
  return `user:${userId}`;
}

/**
 * Tracks which users are present in which page room, purely in memory.
 * For multi-instance deployments, back this with the socket.io Redis
 * adapter and this class becomes a thin read-through cache per instance.
 */
class PresenceStore {
  private rooms = new Map<string, Map<string, RealtimeUser>>();

  join(room: string, user: RealtimeUser): RealtimeUser[] {
    const members = this.rooms.get(room) ?? new Map<string, RealtimeUser>();
    members.set(user.id, user);
    this.rooms.set(room, members);
    return [...members.values()];
  }

  leave(room: string, userId: string): RealtimeUser[] {
    const members = this.rooms.get(room);
    if (!members) return [];
    members.delete(userId);
    if (members.size === 0) this.rooms.delete(room);
    return [...members.values()];
  }

  leaveAll(userId: string): { room: string; users: RealtimeUser[] }[] {
    const affected: { room: string; users: RealtimeUser[] }[] = [];
    for (const [room, members] of this.rooms.entries()) {
      if (members.has(userId)) {
        members.delete(userId);
        affected.push({ room, users: [...members.values()] });
        if (members.size === 0) this.rooms.delete(room);
      }
    }
    return affected;
  }
}

export interface InitRealtimeOptions {
  httpServer: HttpServer;
  /** Verifies the token sent in the socket handshake and returns the user, or throws. */
  authenticate: (token: string | undefined) => Promise<RealtimeUser> | RealtimeUser;
  corsOrigin: string | string[];
  /**
   * Verifies `userId` is actually a member of `chatId` before letting
   * their socket join that chat's room. Without this, anyone who knows
   * (or guesses) a chatId could subscribe to its live messages and typing
   * indicators — the REST endpoints check membership, but a socket room
   * join bypasses REST entirely unless this is enforced here too.
   */
  isChatMember: (chatId: string, userId: string) => Promise<boolean>;
}

export function initRealtime({ httpServer, authenticate, corsOrigin, isChatMember }: InitRealtimeOptions): RealtimeServer {
  const io: RealtimeServer = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
    // WebSocket only — no HTTP long-polling transport. Engine.io's polling
    // transport has a known class of race conditions (concurrent/stale
    // polling requests hitting the same session — most likely after a
    // burst of client reconnect attempts, e.g. right after a period of
    // being unreachable) that can throw ERR_HTTP_HEADERS_SENT from deep
    // inside engine.io's own write path — an *uncaught* exception there
    // crashes the whole Node process, not just the socket connection,
    // taking every REST endpoint down with it. nginx already proxies
    // /socket.io/ with a proper Upgrade header (see deploy/nginx.conf), so
    // there's no reason to keep the polling fallback around just for
    // ancient browsers or restrictive proxies we don't need to support.
    // The client (apps/web/lib/socket.ts) must match this — a client
    // still defaulting to ['polling', 'websocket'] would just fail its
    // initial handshake against a websocket-only server.
    transports: ['websocket'],
  });

  const presence = new PresenceStore();

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      socket.data.user = await authenticate(token);
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>) => {
    const user = socket.data.user;
    socket.join(personalRoomKey(user.id));

    socket.on('page:join', ({ projectId, pageId }) => {
      const room = pageRoomKey(projectId, pageId);
      socket.join(room);
      const users = presence.join(room, user);
      io.to(room).emit('presence:update', { pageId, users });
    });

    socket.on('page:leave', ({ projectId, pageId }) => {
      const room = pageRoomKey(projectId, pageId);
      socket.leave(room);
      const users = presence.leave(room, user.id);
      io.to(room).emit('presence:update', { pageId, users });
    });

    socket.on('page:cursor', ({ projectId, pageId, cursor }) => {
      socket.to(pageRoomKey(projectId, pageId)).emit('page:cursor', { userId: user.id, cursor });
    });

    // Broadcasts a live in-progress edit to collaborators. The authoritative
    // save still goes through the debounced HTTP call in useDocument, which
    // writes via @core/fs-engine — this event is presentation-only.
    socket.on('page:patch', ({ projectId, pageId, blocks }) => {
      socket.to(pageRoomKey(projectId, pageId)).emit('page:patch', { userId: user.id, blocks });
    });

    socket.on('chat:join', async ({ chatId }, ack) => {
      const allowed = await isChatMember(chatId, user.id).catch(() => false);
      if (!allowed) {
        ack?.(false);
        return;
      }
      socket.join(chatRoomKey(chatId));
      ack?.(true);
    });

    socket.on('chat:leave', ({ chatId }) => {
      socket.leave(chatRoomKey(chatId));
    });

    socket.on('chat:typing', ({ chatId, isTyping }) => {
      socket.to(chatRoomKey(chatId)).emit('chat:typing', { chatId, userId: user.id, isTyping });
    });

    socket.on('disconnect', () => {
      for (const { room, users } of presence.leaveAll(user.id)) {
        const pageId = room.split(':')[2] ?? '';
        io.to(room).emit('presence:update', { pageId, users });
      }
    });
  });

  return io;
}

/**
 * Broadcasts a durably-saved chat message to everyone currently in that
 * chat's room. Called from chat.routes.ts right after
 * `ChatEngine.sendMessage()` succeeds — the server is the source of truth
 * for "a message was sent", not the sending client's own optimistic
 * render, so every member (including the sender's other open tabs) gets
 * the same event.
 */
export function emitChatMessage(io: RealtimeServer, chatId: string, message: ChatMessage): void {
  io.to(chatRoomKey(chatId)).emit('chat:message', message);
}

/** Same delivery mechanism as emitChatMessage, distinct event name — see the ServerToClientEvents doc comment on why edits/deletes/reactions can't reuse 'chat:message'. */
export function emitChatMessageUpdated(io: RealtimeServer, chatId: string, message: ChatMessage): void {
  io.to(chatRoomKey(chatId)).emit('chat:message-updated', message);
}

/** Same delivery mechanism, for a message that's genuinely gone rather than just changed — see the ServerToClientEvents doc comment on why this needs a distinct event. */
export function emitChatMessageDeleted(io: RealtimeServer, chatId: string, messageId: string): void {
  io.to(chatRoomKey(chatId)).emit('chat:message-deleted', { chatId, messageId });
}

/** Broadcasts to the room BEFORE the chat's members would have any other way to find out — the caller must emit this while the room still has its members, not after they've been kicked/room's gone stale. */
export function emitChatDeleted(io: RealtimeServer, chatId: string): void {
  io.to(chatRoomKey(chatId)).emit('chat:deleted', { chatId });
}

export function emitChatThreadCountUpdated(io: RealtimeServer, chatId: string, threadRootId: string, replyCount: number): void {
  io.to(chatRoomKey(chatId)).emit('chat:thread-count-updated', { chatId, threadRootId, replyCount });
}
