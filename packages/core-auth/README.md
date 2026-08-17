# @core/auth

JWT authentication + RBAC for the platform. There is **no self-registration**
anywhere in this codebase — accounts are created these ways only:

1. The first Admin is created automatically at server startup from
   `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env` (`seedAdminFromEnv()`,
   idempotent per email — see `apps/server/src/routes/auth.routes.ts`).
2. Admin creates a user directly (`POST /api/admin/users`), which calls
   `FsEngine.createUser()` to provision the root folder and returns a
   temporary password.
3. Admin sends an invite (`POST /api/admin/invites`), which mints a signed,
   7-day invite token via `AuthService.signInviteToken()`. The link the
   invitee opens posts to `/api/auth/accept-invite` to set a password and
   receive their first session — still no open registration form.
4. Manual fallback: `POST /api/auth/bootstrap-admin` works only while the
   workspace has zero accounts at all — same idea as (1) but triggered over
   HTTP instead of `.env`, for when env-based seeding wasn't configured.

`GET /api/auth/me` (behind `requireAuth`) returns the caller's profile —
used by the frontend's `SessionProvider` to restore a session after a hard
refresh, once it's exchanged the refresh cookie for a fresh access token.

## Roles

`Admin > Team-Lead > Member > Guest`, enforced by `roleAtLeast()`. Route
guards:

```ts
router.post('/admin/users', requireAuth(auth), requireRole('Admin'), handler);
```

## Storage isolation

`requireOwnStorageOrShared()` is mounted on every `/api/storage/:userId/*`
route. It immediately rejects cross-user access unless the caller is an
Admin, and otherwise flags `req.requiresSharingCheck = true` so the route
handler must look up the specific page's `sharing[]` list (via
`@core/fs-engine`) before serving the request. This two-step design keeps
the cheap check (are you even allowed to *try*) separate from the
per-resource check (does this specific page grant you access), so a typo'd
`userId` in a URL never leaks another user's folder listing.

## Tokens

- Access token: 15 minutes, sent as `Authorization: Bearer <token>` — or,
  for URLs the browser fetches on its own (`<img src>`, `<a href>`, which
  can't carry custom headers), as a `?token=` query parameter. `requireAuth`
  accepts either form. Use `withAuthToken(url)` (`apps/web/lib/api.ts`) on
  the frontend whenever building a URL like that — see `agent.md`.
- Refresh token: 30 days, stored as an httpOnly cookie by the server app,
  used only to mint new access tokens at `/api/auth/refresh`.
- Secrets come from `ACCESS_TOKEN_SECRET` / `REFRESH_TOKEN_SECRET` env vars —
  `AuthService` throws on construction if either is missing.
