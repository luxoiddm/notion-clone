# @core/webrtc

Signaling only — no media ever passes through the server. `CallSignaling`
relays `call:start` / `call:join` / `call:signal` (SDP + ICE) / `call:leave`
events over the same Socket.io server `@core/realtime` already runs, caps
rooms at 8 participants, and notifies chat members of an incoming call
whether or not they currently have that chat open.

Wire it into `apps/server/src/index.ts` next to `initRealtime`, sharing the
`isChatMember` check both need, plus `getChatMembers` for the incoming-call
broadcast:

```ts
import { CallSignaling } from '@core/webrtc';

const isChatMember = async (chatId: string, userId: string) => {
  try {
    const summary = await chat.getChatSummary(chatId);
    return summary.memberIds.includes(userId);
  } catch {
    return false;
  }
};

const getChatMembers = async (chatId: string) => {
  try {
    return (await chat.getChatSummary(chatId)).memberIds;
  } catch {
    return [];
  }
};

const io = initRealtime({ ..., isChatMember });
new CallSignaling().attach(io, { isChatMember, getChatMembers });
```

## Server-side guarantees

- **Membership-checked.** `call:start` and `call:join` both verify the
  caller is actually a member of the target chat via `isChatMember` before
  doing anything — the same class of check `chat:join` needs in
  `@core/realtime`, for the same reason: without it, anyone who knows (or
  guesses) a `chatId` could start or join its call.
- **`call:start` is idempotent — and only a genuinely new room notifies
  anyone.** Room id is deterministic (`call_${chatId}`) — one active call
  per chat. Calling `call:start` again while a call is already in progress
  returns the *existing* room (`ack(room)`) without resetting it or
  re-broadcasting the incoming-call notification below; only the first
  `call:start` for a chat (the one that actually creates the room) does
  either.
- **Incoming-call notification reaches people who don't have the chat
  open.** When a *new* room is created, every other chat member's personal
  room (`personalRoomKey(userId)` from `@core/realtime` — every socket
  auto-joins its own on connect) gets a `call:incoming` event with
  `{ chatId, roomId, fromUserId, fromUserDisplayName }`. This is what
  lets the client show a global "incoming call" banner regardless of
  which page someone's on, not just inside an already-open chat window.
- **`call:join` de-dupes and enforces the cap.** Joining twice (e.g. two
  tabs) doesn't inflate the participant count; the 8-participant limit
  only blocks a *new* participant, not a rejoin.
- **Cleans up on disconnect, not just `call:leave`.** A closed tab,
  crashed browser, or dropped network removes the user from every room
  they were in and notifies the rest via `call:peer-left` — a room's
  participant list always reflects who's actually connected.
- **`call:signal` is targeted, not broadcast.** SDP/ICE payloads are
  emitted directly to the specific recipient's socket(s)
  (`toUserId`), found by scanning the room's sockets for a matching
  `socket.data.user.id` — not sent to the whole room for clients to
  filter. At up to 8 participants doing pairwise mesh signaling, a
  broadcast would multiply traffic up to 7x and leak every peer's SDP to
  everyone else in the room for no reason.

## Client-side flow

1. `CallProvider` (`apps/web/components/CallProvider.tsx`) listens
   globally for `call:incoming` and surfaces a banner
   (`IncomingCallBanner`) — mounted once at the app root, so it's visible
   no matter what page someone's looking at.
2. On "Start call" (or tapping "Join" on the banner), emit `call:start`,
   get back a `CallRoom` (or `null` + a reason string if the ack failed —
   not a member, not authenticated).
3. Emit `call:join` with that room's `id`, then open an `RTCPeerConnection`
   to every existing participant (mesh topology — fine up to 8 people);
   the convention is that whoever's *already* in the room offers to
   whoever *just* joined, never the other way, so there's no offer glare.
4. Exchange offers/answers/ICE candidates via `call:signal`.
5. Screen share: swap the outgoing video track with
   `getDisplayMedia()` + `RTCRtpSender.replaceTrack()`, no server change.

If usage ever needs to scale past small meshes, replace the mesh with an
SFU (e.g. mediasoup, LiveKit) — the chat-side "Start call" API and the
8-participant cap stay the same either way.

## STUN/TURN

This package only relays signaling messages — it says nothing about which
STUN/TURN servers the client's `RTCPeerConnection` should use for NAT
traversal. `turnCredentials.ts` generates short-lived TURN credentials for
our own self-hosted coturn instance (see `install.md`, "Видеозвонки", and
`deploy/turnserver.conf`) — never a third-party STUN/TURN provider.
