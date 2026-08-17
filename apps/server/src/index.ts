import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { AuthService } from '@core/auth';
import { FsEngine, DEFAULT_TILE_SHEET_COLS, DEFAULT_TILE_SHEET_ROWS, DEFAULT_TILE_SIZE } from '@core/fs-engine';
import { ChatEngine } from '@core/chat';
import { initRealtime } from '@core/realtime';
import { CallSignaling } from '@core/webrtc';
import { createApp } from './app.js';
import { seedAdminFromEnv } from './routes/auth.routes.js';

// Load `.env` by a path resolved from THIS file's location, not from
// process.cwd(). Various process managers / panels (PM2, Passenger,
// systemd, control-panel "Node.js app" wizards) start the app from
// different working directories, and the plain `dotenv/config` import
// only ever looks in `process.cwd()` — if that doesn't happen to be
// `apps/server`, the .env file is silently never loaded and every
// env-dependent feature (ports, ADMIN_EMAIL/PASSWORD, JWT secrets)
// silently falls back to defaults or breaks. Resolving relative to this
// file removes that whole class of "works locally, not on the server" bug.
const here = path.dirname(fileURLToPath(import.meta.url));

// A genuinely uncaught exception leaves the process in an undefined
// state — Node's own guidance is to exit, not try to keep running, so
// this doesn't attempt to swallow/recover. It exists purely so that if
// one happens (like the engine.io polling-transport race that crashed
// this exact process once — see the `transports: ['websocket']` comment
// in @core/realtime), it's an unmissable `[fatal]`-prefixed log line
// instead of PM2 quietly restarting a process that silently died. The
// restart itself is already PM2's job (see deploy/ecosystem.config.cjs).
process.on('uncaughtException', (err) => {
  console.error('[fatal] Необработанное исключение — процесс завершится, перезапуск на стороне PM2/systemd:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Необработанный отклонённый Promise — процесс завершится, перезапуск на стороне PM2/systemd:', reason);
  process.exit(1);
});

// `here` is this file's own directory (apps/server/src), one level
// too deep for anything that should live at the app root — .env and
// STORAGE_ROOT both belong in apps/server itself, so resolve everything
// from `serverRoot`, not `here` directly.
const serverRoot = path.resolve(here, '..');
const envPath = path.resolve(serverRoot, '.env');
const loaded = loadEnv({ path: envPath });

// Read once at startup, not per-request — package.json doesn't change
// while the process is running. Same serverRoot as everything else here,
// so this resolves correctly whether we're running from src/ (tsx, dev)
// or dist/ (compiled, prod) — both are exactly one level under apps/server.
const APP_VERSION = (JSON.parse(readFileSync(path.join(serverRoot, 'package.json'), 'utf-8')) as { version: string }).version;

if (loaded.error) {
  console.warn(`[startup] Не удалось загрузить ${envPath}: ${loaded.error.message}`);
  console.warn('[startup] Сервер продолжит запуск с переменными окружения процесса, если они заданы отдельно (панелью/systemd).');
} else {
  console.log(`[startup] Переменные окружения загружены из ${envPath}`);
}

// Fail loudly and specifically instead of letting a missing secret surface
// later as a cryptic JWT/crash error deep in a request handler.
const REQUIRED_VARS = ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET'] as const;
const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[startup] В .env отсутствуют обязательные переменные: ${missing.join(', ')}`);
  console.error(`[startup] Ожидаемое расположение файла: ${envPath}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4000);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
// Resolved relative to `serverRoot` (apps/server), not process.cwd() — so
// a relative STORAGE_ROOT always lands inside the project regardless of
// the process manager's working directory. An absolute path (e.g. a
// mounted volume in production) still works as-is: path.resolve() ignores
// the base once the second argument is already absolute.
const STORAGE_ROOT = path.resolve(serverRoot, process.env.STORAGE_ROOT ?? './storage');

console.log(`[startup] PORT=${PORT}  WEB_ORIGIN=${WEB_ORIGIN}  STORAGE_ROOT=${STORAGE_ROOT}`);

const auth = new AuthService({
  accessTokenSecret: process.env.ACCESS_TOKEN_SECRET!,
  refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET!,
});

// Falls back to undefined (letting FsEngine apply its own default) for
// anything missing, non-numeric, zero, negative, or non-integer — a
// silently-coerced bad value (e.g. TILE_SHEET_COLS=abc becoming 0 or
// NaN) would be a much more confusing failure mode than just using the
// sensible built-in default.
function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const tileSheetCols = parsePositiveInt(process.env.TILE_SHEET_COLS) ?? DEFAULT_TILE_SHEET_COLS;
const tileSheetRows = parsePositiveInt(process.env.TILE_SHEET_ROWS) ?? DEFAULT_TILE_SHEET_ROWS;
const tileSize = parsePositiveInt(process.env.TILE_SIZE) ?? DEFAULT_TILE_SIZE;
const fs = new FsEngine({ storageRoot: STORAGE_ROOT, tileSheetCols, tileSheetRows, tileSize });
console.log(`[startup] tile-sheet grid: ${tileSheetCols} cols × ${tileSheetRows} rows, ${tileSize}px tiles`);
const chat = new ChatEngine(STORAGE_ROOT);

async function main() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    console.warn(
      '[startup] ADMIN_EMAIL/ADMIN_PASSWORD не заданы в .env — первый администратор не будет создан ' +
        'автоматически. Используй POST /api/auth/bootstrap-admin вручную (см. install.md) или скрипт ' +
        '"npm run admin:reset-password" (см. install.md).',
    );
  } else {
    console.log(`[startup] Ожидаемый администратор из .env: ${process.env.ADMIN_EMAIL}`);
  }

  // Creates/verifies the first Admin from ADMIN_EMAIL/ADMIN_PASSWORD in
  // .env. Logs exactly what it did — check this line first if login fails.
  await seedAdminFromEnv(auth, fs);

  // `io` needs an httpServer, and the Express `app` needs `io` (chatRoutes
  // emits `chat:message` through it) — so the app can't be built first and
  // handed to createServer() as usual. Instead: bare httpServer -> io ->
  // app, then attach the app as the httpServer's request listener last.
  const httpServer = createServer();

  // Shared between initRealtime (chat:join) and CallSignaling
  // (call:start/call:join) — both need the identical "is this user
  // actually a member of this chat" check before letting a socket touch
  // it, so it's defined once here rather than copy-pasted into each.
  const isChatMember = async (chatId: string, userId: string) => {
    try {
      const summary = await chat.getChatSummary(chatId);
      return summary.memberIds.includes(userId);
    } catch {
      return false; // chat doesn't exist (or is unreadable) — treat as not a member
    }
  };

  // Used by CallSignaling to notify every *other* chat member when a call
  // starts — not just the ones who happen to already be in the room.
  const getChatMembers = async (chatId: string): Promise<string[]> => {
    try {
      const summary = await chat.getChatSummary(chatId);
      return summary.memberIds;
    } catch {
      return [];
    }
  };

  const io = initRealtime({
    httpServer,
    corsOrigin: WEB_ORIGIN,
    authenticate: async (token) => {
      const payload = auth.verifyAccessToken(token ?? '');
      // Unlike displayName (baked into the JWT at login/refresh time, so
      // it's only as fresh as the last token issuance), avatarUrl is
      // resolved fresh here — a changed avatar shows up in presence the
      // very next reconnect, not "whenever the access token happens to
      // rotate next".
      const profile = await fs.getUser(payload.sub).catch(() => null);
      return { id: payload.sub, displayName: payload.displayName, avatarUrl: profile?.avatarUrl ?? null };
    },
    isChatMember,
  });

  new CallSignaling().attach(io, { isChatMember, getChatMembers });

  const app = createApp({ auth, fs, chat, io, webOrigin: WEB_ORIGIN, version: APP_VERSION });
  httpServer.on('request', app);

  httpServer.listen(PORT, () => {
    console.log(`[startup] Сервер слушает http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[startup] Фатальная ошибка при старте сервера:', err);
  process.exit(1);
});
