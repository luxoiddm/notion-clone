# @core/realtime

Socket.io wrapper providing:

- **Presence** — who is currently viewing a page (`presence:update`), used
  to render the green online dot / avatar stack in the editor header.
- **Cursor broadcasting** — `page:cursor` relays the emitting user's caret
  position (`blockId` + `offset`) to everyone else in the room.
- **Live patch relay** — `page:patch` mirrors in-progress edits to
  collaborators for immediate visual feedback. This is presentation-only;
  the durable save still goes through the debounced REST call in
  `useDocument`, which persists via `@core/fs-engine`. This module never
  touches the filesystem.
- **Typing indicators** for chat.

## Wiring it up

```ts
import { createServer } from 'node:http';
import { initRealtime } from '@core/realtime';

const httpServer = createServer(app);

initRealtime({
  httpServer,
  corsOrigin: process.env.WEB_ORIGIN!,
  authenticate: async (token) => {
    const payload = auth.verifyAccessToken(token ?? '');
    return { id: payload.sub, displayName: payload.displayName };
  },
});

httpServer.listen(4000);
```

## Scaling beyond one process

`PresenceStore` is in-memory per Node process. For multiple instances behind
a load balancer, add the `@socket.io/redis-adapter` and back `PresenceStore`
with Redis hashes keyed by room — the public event contract above does not
change.
