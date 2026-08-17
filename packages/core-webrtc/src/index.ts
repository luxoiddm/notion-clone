import type { Server, Socket } from 'socket.io';
import { personalRoomKey } from '@core/realtime';

export { generateTurnCredential, buildIceServers } from './turnCredentials.js';
export type { TurnCredential, IceServer, BuildIceServersOptions } from './turnCredentials.js';

export interface CallRoom {
  id: string;
  chatId: string;
  participantIds: string[];
  createdAt: string;
}

const MAX_PARTICIPANTS = 8;

export interface CallSignalingOptions {
  /**
   * Verifies `userId` is actually a member of `chatId` before letting
   * them start or join a call there. Without this, anyone who knows (or
   * guesses) a chatId could join its call — the same class of gap that
   * `chat:join` in @core/realtime had to close for text messages; calls
   * need the identical check, not a reason to skip it because "it's a
   * different feature".
   */
  isChatMember: (chatId: string, userId: string) => Promise<boolean>;
  /** All member ids of a chat — used to notify everyone *not yet* in a newly-started call, not just to gate access. */
  getChatMembers: (chatId: string) => Promise<string[]>;
}

/**
 * Pure signaling relay — this module never touches media itself. It:
 *  1. Creates a "room" (just bookkeeping) when someone clicks "Start call"
 *     in a chat — idempotent: calling it again while a call is already in
 *     progress returns the *existing* room instead of resetting it and
 *     losing track of who's already joined. Only a genuinely *new* room
 *     triggers the incoming-call notification below — rejoining an
 *     already-announced call doesn't spam everyone again.
 *  2. Notifies every other chat member's personal room (`user:{id}`, see
 *     `@core/realtime`) that a call started — this is what lets someone
 *     see an incoming-call banner while they're anywhere else in the app,
 *     not just when they happen to have that chat open.
 *  3. Relays SDP offers/answers and ICE candidates between peers so the
 *     browsers can establish a direct (mesh) WebRTC connection — targeted
 *     at the specific recipient socket, not broadcast to the whole room
 *     (mesh signaling between up to 8 people would otherwise multiply
 *     traffic up to 7x, and leak every peer's SDP to everyone else in the
 *     room for no reason).
 *  4. Enforces the 8-participant cap from the spec.
 *  5. Cleans up on a plain socket disconnect (closed tab, crashed
 *     browser, dropped network) — not just on an explicit `call:leave` —
 *     so a room's participant count always reflects who's actually
 *     connected, not who forgot to hang up.
 *
 * Client side: each participant opens an RTCPeerConnection to every other
 * participant (mesh topology, appropriate up to ~8 people; beyond that an
 * SFU like mediasoup/LiveKit would replace this module without changing
 * the chat-side API). Screen share reuses the same peer connection via
 * `getDisplayMedia()` + `replaceTrack()` on the video sender — no server
 * changes needed for that.
 */
export class CallSignaling {
  private rooms = new Map<string, CallRoom>();

  attach(io: Server, { isChatMember, getChatMembers }: CallSignalingOptions) {
    io.on('connection', (socket: Socket) => {
      const socketUser = (socket.data as { user?: { id: string; displayName: string } }).user;
      const userId = socketUser?.id;

      socket.on('call:start', async ({ chatId }: { chatId: string }, ack: (room: CallRoom | null, reason?: string) => void) => {
        if (!userId || !socketUser) return ack(null, 'Not authenticated');
        const allowed = await isChatMember(chatId, userId).catch(() => false);
        if (!allowed) return ack(null, 'Not a member of this chat');

        const roomId = `call_${chatId}`;
        const existing = this.rooms.get(roomId);
        if (existing) {
          ack(existing); // a call is already in progress here — join it, don't reset it or re-notify
          return;
        }

        const room: CallRoom = { id: roomId, chatId, participantIds: [], createdAt: new Date().toISOString() };
        this.rooms.set(roomId, room);
        ack(room);

        const memberIds = await getChatMembers(chatId).catch(() => [] as string[]);
        for (const memberId of memberIds) {
          if (memberId === userId) continue;
          io.to(personalRoomKey(memberId)).emit('call:incoming', {
            chatId,
            roomId: room.id,
            fromUserId: userId,
            fromUserDisplayName: socketUser.displayName,
          });
        }
      });

      socket.on('call:join', async ({ roomId }: { roomId: string }, ack: (ok: boolean, reason?: string) => void) => {
        const room = this.rooms.get(roomId);
        if (!room || !userId) return ack(false, 'Room not found');

        const allowed = await isChatMember(room.chatId, userId).catch(() => false);
        if (!allowed) return ack(false, 'Not a member of this chat');

        if (!room.participantIds.includes(userId)) {
          if (room.participantIds.length >= MAX_PARTICIPANTS) return ack(false, 'Room is full (max 8 participants)');
          room.participantIds.push(userId);
        }

        socket.join(roomId);
        socket.to(roomId).emit('call:peer-joined', { userId });
        ack(true);
      });

      socket.on('call:signal', (payload: { roomId: string; toUserId: string; data: unknown }) => {
        if (!userId) return;
        emitToUserInRoom(io, payload.roomId, payload.toUserId, 'call:signal', { fromUserId: userId, data: payload.data });
      });

      socket.on('call:leave', ({ roomId }: { roomId: string }) => {
        this.removeFromRoom(socket, roomId, userId);
      });

      socket.on('disconnect', () => {
        if (!userId) return;
        for (const room of this.rooms.values()) {
          if (room.participantIds.includes(userId)) {
            this.removeFromRoom(socket, room.id, userId);
          }
        }
      });
    });
  }

  private removeFromRoom(socket: Socket, roomId: string, userId: string | undefined) {
    const room = this.rooms.get(roomId);
    if (room && userId) {
      room.participantIds = room.participantIds.filter((id) => id !== userId);
      if (room.participantIds.length === 0) this.rooms.delete(roomId);
    }
    socket.leave(roomId);
    socket.to(roomId).emit('call:peer-left', { userId });
  }
}

/** Emits directly to whichever socket(s) in `roomId` belong to `toUserId` — not a room-wide broadcast. */
function emitToUserInRoom(io: Server, roomId: string, toUserId: string, event: string, payload: unknown) {
  const roomSockets = io.sockets.adapter.rooms.get(roomId);
  if (!roomSockets) return;
  for (const socketId of roomSockets) {
    const target = io.sockets.sockets.get(socketId);
    if (target && (target.data as { user?: { id: string } }).user?.id === toUserId) {
      target.emit(event, payload);
    }
  }
}
