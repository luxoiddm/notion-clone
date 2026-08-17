# @core/chat

File-backed private and group messaging.

- Private chats: exactly two members, one JSONL history file.
  `getOrCreatePrivateChat(a, b)` reuses an existing one instead of
  spawning a duplicate every time someone clicks "message" on the same
  person.
- Group chats: tied to a `projectId`, any number of members.
- `listChatsForUser(userId)` — every chat a user belongs to, each with
  its most recent message for a list/preview view. Scans all
  `*.meta.json` files (flat, not indexed) — fine at team scale.
- Threads: a reply sets `threadRootId` to the message it replies to;
  `getRecentMessages` only returns top-level messages, `getThreadReplies`
  fetches a specific thread.
- `pageRef` lets a message embed a Knowledge Base page reference, which
  the web app renders as a link-preview card.
- **Editing, deleting, reactions** — `editMessage`/`deleteMessage` are
  author-only (throw otherwise); `toggleReaction` is open to any chat
  member and toggles (reacting twice with the same emoji removes it).
  Deletion is soft — `text`/`pageRef`/`reactions` are cleared but the
  message row stays, so thread replies pointing at it via `threadRootId`
  don't end up referencing nothing.

## Storage & concurrency

Messages live in JSONL files, one line per message
(`/storage/chats/{private,group}/{chatId}.jsonl`). New messages are
appended; editing, deleting, and reacting are read-modify-write (read the
whole file, replace one line, write it all back via a temp-file-then-
rename atomic swap — same pattern `@core/fs-engine` uses for
`meta.json`). **Every** file operation, including the plain append in
`sendMessage`, goes through an in-process lock keyed on the file path
(`lockManager.ts`, a self-contained copy of `@core/fs-engine`'s — small
and generic enough not to be worth a cross-package dependency for) — this
is what stops a concurrent edit/delete from reading a stale snapshot,
overwriting it, and silently dropping a message someone else sent in the
same moment.

## Realtime delivery

`@core/realtime` exports `emitChatMessage` (new message) and
`emitChatMessageUpdated` (edit/delete/reaction — anything that mutates an
*existing* message) as two distinct Socket.io events. They have to be
separate: the web client's `chat:message` handler appends-if-absent by
id, so replaying an edit through that same event would just get silently
deduped as "already have this message" instead of updating it.

## Video calls

`@core/webrtc` hangs a "Start call"/"Join call" flow off a `chatId` —
`CallSignaling` checks chat membership the same way this package's own
routes do (`isChatMember`/`getChatMembers`, see
`apps/server/src/index.ts`). See the root README and `install.md` for the
self-hosted TURN/STUN setup this needs.
