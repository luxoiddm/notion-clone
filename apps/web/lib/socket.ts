import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** Returns the single shared Socket.io connection, creating it on first use. Shared across presence and chat so we never open more than one connection per tab. */
export function getSocket(token: string): Socket {
  if (!socket) {
    socket = io(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000', {
      auth: { token },
      withCredentials: true,
      // Must match the server's `transports: ['websocket']`
      // (packages/core-realtime) — the server no longer accepts HTTP
      // long-polling at all, so leaving this at the client default
      // (['polling', 'websocket']) would just make every connection
      // attempt its initial handshake over polling first and fail before
      // ever reaching websocket.
      transports: ['websocket'],
    });
  }
  return socket;
}
