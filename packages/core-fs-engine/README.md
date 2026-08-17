# @core/fs-engine

Async, thread-safe file-system storage engine for the knowledge-base content.
There is no database for content — every page is a folder on disk. This
package is the *only* module allowed to touch that folder tree; every other
part of the system (API routes, sockets, chat) calls through here.

## On-disk layout

```
/storage
  /auth
    credentials.json                # email -> { userId, passwordHash }, all accounts
  /users
    /{userID}/
      meta.json                     # UserMeta
      /files/                       # personal file storage — independent of any page
        manifest.json               # fileName -> { originalName, mimeType, size, uploadedAt }
        169...-a1b2c3d4-report.pdf
      /{projectID}/
        meta.json                   # ProjectMeta
        /pages/
          /{pageID}/
            meta.json                # PageMeta (title, parentId, sharing, order...)
            content.json             # PageContent — array of blocks
            /.history/
              2026-07-16T10-00-00-000Z.json   # snapshot taken before each save
            /.assets/
              169...-a1b2c3d4-image.png       # drag-and-drop uploads, scoped to this page
  /chats
    /private/{chatId}.jsonl
    /group/{chatId}.jsonl
```

IDs (`userID`, `projectID`, `pageID`) are always server-generated UUIDs or
admin-assigned slugs matching `^[a-zA-Z0-9_-]{1,128}$` — never raw user
input dropped into a path. See `pathSafety.ts`. File names under `files/`
and `.assets/` go through `sanitizeFileName()` instead (they need to keep
extensions/dots that `assertSafeId()` would reject).

Note there are **two separate places files live**, both accessed only
through this package: per-page `.assets/` (drag-and-drop uploads scoped to
one article — this was an explicit requirement from the start) and the
per-user `files/` library (reusable across every article, backs the
`/Image` and `/File` slash commands and the `/files` page in the web app).
Don't merge them — they serve different UX purposes.

## API

```ts
import { FsEngine } from '@core/fs-engine';

const engine = new FsEngine({ storageRoot: '/var/data/storage' });

// Users (admin-only in the API layer, engine itself has no RBAC opinion)
await engine.createUser('u_123', { displayName: 'Ada', role: 'Member' });
await engine.getUser('u_123');
await engine.listUsers();                                   // Admin panel
await engine.updateUser('u_123', { displayName: 'Ada L.', role: 'Team-Lead' });
await engine.deleteUser('u_123');                             // wipes the user's whole folder + credentials
await engine.hasAnyUsers();                                   // gates the manual bootstrap-admin endpoint

// Credentials (persisted — survives server restarts, unlike an in-memory map)
await engine.setCredential('ada@company.com', 'u_123', passwordHash);
await engine.getCredentialByEmail('ada@company.com');
await engine.getAllCredentials();
await engine.removeCredentialsForUser('u_123');               // called by deleteUser()

// Projects
const project = await engine.createProject('u_123', 'Marketing');
await engine.listProjects('u_123');

// Pages
const page = await engine.createPage('u_123', project.id, { title: 'Roadmap', authorId: 'u_123' });
await engine.getPageMeta('u_123', project.id, page.id);
await engine.getPageContent('u_123', project.id, page.id);
await engine.savePageContent('u_123', project.id, page.id, content, 'u_123');
await engine.renamePage('u_123', project.id, page.id, 'Q3 Roadmap', 'u_123');
await engine.movePage('u_123', project.id, page.id, newParentId, newOrder, 'u_123');
await engine.deletePage('u_123', project.id, page.id);
await engine.listPages('u_123', project.id);                  // nested PageNode[] tree, own pages only

// Sharing
await engine.updatePageSharing('u_123', project.id, page.id, [{ userId: 'u_456', level: 'edit' }], 'u_123');
await engine.listSharedPages('u_456');                         // pages shared WITH u_456, across every other user

// History
await engine.listHistory('u_123', project.id, page.id);
await engine.restoreHistorySnapshot('u_123', project.id, page.id, file, 'u_123');

// Page assets (drag-and-drop uploads, scoped to one page)
await engine.saveAsset('u_123', project.id, page.id, 'photo.png', buffer, 'image/png');
engine.getAssetAbsolutePath('u_123', project.id, page.id, fileName); // for the serving route (res.sendFile)

// Personal file storage (reusable across pages)
await engine.saveUserFile('u_123', 'report.pdf', buffer, 'application/pdf');
await engine.listUserFiles('u_123');
await engine.deleteUserFile('u_123', fileName);
engine.getUserFileAbsolutePath('u_123', fileName);             // for the serving route (res.sendFile)

// Search (naive scan; swap for a Fuse.js/Lunr index if the corpus grows)
await engine.searchPages('u_123', project.id, 'roadmap');
```

## Safety guarantees

- **Path traversal**: every path is built with `joinSafe()`, which resolves
  the final absolute path and rejects anything that would escape
  `storageRoot`. IDs are validated against `assertSafeId()` before ever
  reaching the filesystem; free-form file names go through
  `sanitizeFileName()` instead.
- **Concurrency**: writes to the same page folder, credentials file, or
  per-user file manifest are serialized through `lockManager` (in-process
  async mutex keyed by absolute path). Swap it for `proper-lockfile` if you
  run more than one Node process against the same disk.
- **Atomic writes**: `meta.json` / `content.json` / `credentials.json` /
  `manifest.json` are written to a temp file and `rename()`d into place, so
  a crash mid-write can never leave a half-written JSON file behind.
- **History**: every `savePageContent()` call snapshots the *previous*
  content into `.history/` before overwriting, capped at
  `maxHistorySnapshots` (default 200, oldest pruned first).

This package makes no RBAC decisions itself, with one exception baked into
`listSharedPages()` (it only returns pages with an explicit `sharing[]`
grant for the given viewer, or `'*'`). Everything else — verifying the
caller is allowed to act as `ownerId`, checking `sharing[]` levels before
edits — is `@core/auth`'s middleware and the route handlers' job; see
`agent.md` for the `requiresSharingCheck` contract.
