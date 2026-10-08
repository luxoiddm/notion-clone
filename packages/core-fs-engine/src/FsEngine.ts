import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { assertSafeId, joinSafe, sanitizeFileName, sanitizeDisplayFileName, safeExtension } from './pathSafety.js';
import { lockManager } from './lockManager.js';
import {
  AssetInfo,
  Comment,
  FsEngineError,
  HistorySnapshot,
  PageContent,
  PageMeta,
  PageNode,
  ProjectMeta,
  PublicNode,
  PublicNodeStatus,
  PublicSite,
  PublicInboxItem,
  SiteImageKind,
  FAVICON_SIZES,
  UserFileManifestEntry,
  FileRef,
  FaviconSize,
  PUBLIC_SITE_RESERVED_SLUGS,
  SiteSettings,
  UserFileInfo,
  UserMeta,
} from './types.js';

export interface FsEngineOptions {
  /** Absolute path to the storage root. FsEngine has no opinion on where this lives — apps/server decides (see its .env / STORAGE_ROOT). */
  storageRoot: string;
  /** Keep at most this many history snapshots per page (oldest pruned first). */
  maxHistorySnapshots?: number;
  /** Sprite-sheet tile-set grid layout — columns, rows, and the pixel size of each square tile. Defaults match the original fixed layout (4x5 grid of 64x64 tiles); configurable so a deployer with differently-cut sheets (e.g. 4x4 of 128x128) doesn't need a code change. Doesn't affect folder-of-individual-files tile sets at all — those have no grid, each file is its own tile regardless of size. */
  tileSheetCols?: number;
  tileSheetRows?: number;
  tileSize?: number;
}

const DEFAULT_MAX_SNAPSHOTS = 200;
export const DEFAULT_TILE_SHEET_COLS = 4;
export const DEFAULT_TILE_SHEET_ROWS = 5;
export const DEFAULT_TILE_SIZE = 64;

async function readJson<T>(filePath: string): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new FsEngineError(`Not found: ${filePath}`, 'NOT_FOUND', err);
    }
    throw new FsEngineError(`Failed to read JSON: ${filePath}`, 'IO_ERROR', err);
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath); // atomic on the same filesystem
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw new FsEngineError(`Failed to write JSON: ${filePath}`, 'IO_ERROR', err);
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

/**
 * Strips HTML tags and decodes the handful of entities
 * `lib/sanitize.ts`'s `escapeToHtml()` (the web app's client-side
 * equivalent) ever produces (`&amp;`/`&lt;`/`&gt;`/`&quot;`), so
 * `searchPages` below matches against what a reader actually *sees*, not
 * the raw markup `PageBlock.content` stores for rich-text blocks (bold,
 * italic, links, etc.). Without this, a word with formatting applied to
 * only part of it — e.g. two letters italicized in the middle — would
 * never match a search for the whole word: the tag characters sit
 * literally in the middle of the string, splitting
 * `разреш<i>ен</i>ная` away from a search for `разрешенная`.
 *
 * There's no DOM available server-side (this runs in Node, not a
 * browser) to do this properly the way the client does elsewhere in this
 * codebase (e.g. `lib/pasteToBlocks.ts`'s `plainTextOf`, which sets
 * `div.innerHTML` and reads `.textContent`) — a real HTML parser
 * dependency would be overkill for "does this substring appear in the
 * rendered text", so this is a lightweight regex approximation instead,
 * good enough for matching purposes but not a general-purpose HTML-to-
 * text converter (it won't, for instance, insert a space where a block-
 * level element boundary would visually separate two words — irrelevant
 * here since this only ever runs on one already-inline block's content
 * at a time, never a whole page of block-level markup at once).
 */
function stripHtmlForSearch(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/**
 * Fills in defaults for fields that didn't exist yet when older user
 * records were written (`avatarUrl`/`accentColor` — added after some
 * users already existed). Same reasoning as `normalizeMessage` in
 * `@core/chat`: `readJson<UserMeta>(...)` is only a compile-time
 * assertion, not a runtime guarantee the file on disk actually has these
 * keys. Applied on every read (getUser/listUsers/updateUser), not a
 * one-off migration script, so it stays correct for records nobody's
 * gotten around to migrating.
 */
function normalizeUserMeta(raw: Partial<UserMeta>): UserMeta {
  return {
    id: raw.id ?? '',
    displayName: raw.displayName ?? '',
    role: raw.role ?? 'Guest',
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    avatarUrl: raw.avatarUrl ?? null,
    accentColor: raw.accentColor ?? null,
    enabled: raw.enabled ?? true,
    dismissedAt: raw.dismissedAt ?? null,
  };
}

/** Same defensive-defaults reasoning as normalizeUserMeta/normalizeMessage in @core/chat — `JSON.parse(...) as Partial<Comment>` is only a compile-time assertion, not a runtime guarantee every field is actually present. */
function normalizeComment(raw: Partial<Comment>): Comment {
  return {
    id: raw.id ?? '',
    authorId: raw.authorId ?? '',
    text: raw.text ?? '',
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    editedAt: raw.editedAt ?? null,
    reactions: raw.reactions ?? {},
  };
}

/**
 * `PageMeta` is read raw in 8 different spots across this file (unlike
 * UserMeta/Comment/SiteSettings, which each have one central read
 * choke point) — routing all of them through here instead of adding a
 * normalize call at each site individually means backfilling a newly
 * added field (like `tags`) for pages written before it existed only
 * needs one change, not eight separately-verified ones.
 */
async function readPageMeta(metaPath: string): Promise<PageMeta> {
  const raw = await readJson<PageMeta>(metaPath);
  return { ...raw, tags: raw.tags ?? [] };
}

/**
 * FsEngine is the single, thread-safe gateway to everything under
 * `storageRoot`. No other module should touch the filesystem directly —
 * routing all reads/writes through here is what makes the "user can never
 * reach another user's files" guarantee enforceable in one place.
 */
export class FsEngine {
  private readonly root: string;
  private readonly maxHistorySnapshots: number;
  private readonly tileSheetCols: number;
  private readonly tileSheetRows: number;
  private readonly tileSize: number;

  constructor(options: FsEngineOptions) {
    this.root = path.resolve(options.storageRoot);
    this.maxHistorySnapshots = options.maxHistorySnapshots ?? DEFAULT_MAX_SNAPSHOTS;
    this.tileSheetCols = options.tileSheetCols ?? DEFAULT_TILE_SHEET_COLS;
    this.tileSheetRows = options.tileSheetRows ?? DEFAULT_TILE_SHEET_ROWS;
    this.tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
  }

  // ---------------------------------------------------------------------
  // Site settings — one admin-managed record, not scoped to any user.
  // ---------------------------------------------------------------------

  private siteSettingsPath(): string {
    return joinSafe(this.root, 'site-settings.json');
  }

  private static readonly SITE_SETTINGS_DEFAULTS: Omit<SiteSettings, 'updatedAt'> = {
    siteName: 'Workspace',
    siteDescription: 'Корпоративная база знаний и командная работа',
    copyrightText: '',
    loginLogoUrl: null,
    headerLogoUrl: null,
    loginBackgroundUrl: null,
    faviconUrl: null,
    loginLogoDarkUrl: null,
    headerLogoDarkUrl: null,
    darkLogoMode: 'auto',
    logoTone: {},
  };

  /**
   * Returns sensible defaults if no admin has ever saved settings yet —
   * never throws NOT_FOUND for this one, since the login screen needs
   * *something* to show before anyone has configured anything.
   *
   * `legacyLogoUrl` covers records written before the single `logoUrl`
   * field was split into `loginLogoUrl`/`headerLogoUrl` — falls back to
   * it for *both* new fields if neither has been set yet, so an admin
   * who already uploaded a logo before this split doesn't see it vanish
   * from either spot.
   */
  async getSiteSettings(): Promise<SiteSettings> {
    try {
      const raw = await readJson<Partial<SiteSettings> & { logoUrl?: string | null }>(this.siteSettingsPath());
      const legacyLogoUrl = raw.logoUrl ?? null;
      return {
        ...FsEngine.SITE_SETTINGS_DEFAULTS,
        updatedAt: new Date(0).toISOString(),
        ...raw,
        // Наследный общий `logoUrl` подставляем только если поле ещё ни разу
        // не задавалось. Явный null («логотип убран») — это осознанный
        // выбор, и через `??` он бы снова превращался в старый логотип.
        loginLogoUrl: 'loginLogoUrl' in raw ? (raw.loginLogoUrl ?? null) : legacyLogoUrl,
        headerLogoUrl: 'headerLogoUrl' in raw ? (raw.headerLogoUrl ?? null) : legacyLogoUrl,
        loginBackgroundUrl: raw.loginBackgroundUrl ?? null,
        faviconUrl: raw.faviconUrl ?? null,
        loginLogoDarkUrl: raw.loginLogoDarkUrl ?? null,
        headerLogoDarkUrl: raw.headerLogoDarkUrl ?? null,
        darkLogoMode: raw.darkLogoMode === 'invert' || raw.darkLogoMode === 'none' ? raw.darkLogoMode : 'auto',
        logoTone: raw.logoTone && typeof raw.logoTone === 'object' ? raw.logoTone : {},
      };
    } catch (err) {
      if (err instanceof FsEngineError && err.code === 'NOT_FOUND') {
        return { ...FsEngine.SITE_SETTINGS_DEFAULTS, updatedAt: new Date(0).toISOString() };
      }
      throw err;
    }
  }

  async updateSiteSettings(patch: Partial<Omit<SiteSettings, 'updatedAt'>>): Promise<SiteSettings> {
    const settingsPath = this.siteSettingsPath();
    return lockManager.run(settingsPath, async () => {
      const current = await this.getSiteSettings();
      const updated: SiteSettings = { ...current, ...patch, updatedAt: new Date().toISOString() };
      await writeJsonAtomic(settingsPath, updated);
      return updated;
    });
  }

  private siteLogoPath(kind: SiteImageKind): string {
    return joinSafe(this.root, 'site', `logo-${kind}.webp`);
  }

  /** Поле SiteSettings, в котором хранится URL картинки этого вида. */
  static siteImageField(
    kind: SiteImageKind,
  ): 'loginLogoUrl' | 'headerLogoUrl' | 'loginBackgroundUrl' | 'loginLogoDarkUrl' | 'headerLogoDarkUrl' {
    switch (kind) {
      case 'login':
        return 'loginLogoUrl';
      case 'header':
        return 'headerLogoUrl';
      case 'login-dark':
        return 'loginLogoDarkUrl';
      case 'header-dark':
        return 'headerLogoDarkUrl';
      default:
        return 'loginBackgroundUrl';
    }
  }

  /** Убирает картинку сайта (логотип или фон экрана входа): удаляет файл и обнуляет ссылку в настройках. */
  async deleteSiteImage(kind: SiteImageKind): Promise<SiteSettings> {
    const imgPath = this.siteLogoPath(kind);
    await lockManager.run(imgPath, async () => {
      await fs.rm(imgPath, { force: true });
    });
    if (kind === 'login' || kind === 'header') {
      const { logoTone } = await this.getSiteSettings();
      const { [kind]: _removed, ...rest } = logoTone;
      return this.updateSiteSettings({ [FsEngine.siteImageField(kind)]: null, logoTone: rest });
    }
    return this.updateSiteSettings({ [FsEngine.siteImageField(kind)]: null });
  }

  /**
   * A single fixed filename per kind, overwritten each time — unlike
   * personal files (`saveUserFile`), there's no manifest and no history
   * of past logos, because there's only ever one *current* logo of each
   * kind. Returns the public serve path directly
   * (`/api/site-settings/logo/{kind}`) — the caller still has to fold
   * that into `updateSiteSettings({ loginLogoUrl / headerLogoUrl })`
   * itself, this only writes the bytes.
   *
   * IMPORTANT for whoever renders this URL: it never changes across
   * uploads (no hash/timestamp in the path), so a browser that's already
   * cached the old logo has no reason to re-fetch it after a replacement.
   * Append `SiteSettings.updatedAt` as a cache-busting query string
   * (`?v=${updatedAt}`) wherever this is used as an `<img src>`.
   */
  async saveSiteLogo(kind: SiteImageKind, data: Buffer): Promise<string> {
    const logoPath = this.siteLogoPath(kind);
    await fs.mkdir(path.dirname(logoPath), { recursive: true });
    await lockManager.run(logoPath, async () => {
      await fs.writeFile(logoPath, data);
    });
    return `/api/site-settings/logo/${kind}`;
  }

  // ---- Favicon -----------------------------------------------------------
  // Хранится набором готовых PNG (`site/favicon-{32,180,192,512}.png`) —
  // их режет из загруженной картинки admin.routes.ts — либо, если
  // загружен именно .ico, как есть (`site/favicon.ico`, только для
  // вкладки браузера). Отдаётся публичным GET /api/site-settings/favicon/:size.

  private faviconPath(size: FaviconSize | 'ico'): string {
    return joinSafe(this.root, 'site', size === 'ico' ? 'favicon.ico' : `favicon-${size}.png`);
  }

  /** Сохраняет новый favicon, предварительно удалив старый (PNG-набор или .ico). Возвращает обновлённые настройки. */
  async saveFavicon(files: { png?: Partial<Record<FaviconSize, Buffer>>; ico?: Buffer }): Promise<SiteSettings> {
    await this.removeFaviconFiles();
    const dir = path.dirname(this.faviconPath('ico'));
    await fs.mkdir(dir, { recursive: true });
    if (files.ico) await fs.writeFile(this.faviconPath('ico'), files.ico);
    for (const size of FAVICON_SIZES) {
      const buf = files.png?.[size];
      if (buf) await fs.writeFile(this.faviconPath(size), buf);
    }
    return this.updateSiteSettings({ faviconUrl: '/api/site-settings/favicon/32' });
  }

  private async removeFaviconFiles(): Promise<void> {
    await fs.rm(this.faviconPath('ico'), { force: true });
    for (const size of FAVICON_SIZES) await fs.rm(this.faviconPath(size), { force: true });
  }

  /** Возвращает к стандартной иконке. */
  async deleteFavicon(): Promise<SiteSettings> {
    await this.removeFaviconFiles();
    return this.updateSiteSettings({ faviconUrl: null });
  }

  /**
   * Путь к файлу favicon нужного размера или null, если своего нет
   * (тогда маршрут отдаёт стандартную иконку). Для 32px (вкладка)
   * подходит и загруженный .ico; для остальных размеров нужен PNG.
   */
  async resolveFavicon(size: FaviconSize): Promise<{ path: string; type: string } | null> {
    const exists = async (p: string) => !!(await fs.stat(p).catch(() => null));
    const png = this.faviconPath(size);
    if (await exists(png)) return { path: png, type: 'image/png' };
    if (size === 32 && (await exists(this.faviconPath('ico')))) return { path: this.faviconPath('ico'), type: 'image/x-icon' };
    return null;
  }

  /** Resolves the absolute path to the current logo of this kind, for the public serving route. Doesn't check the file actually exists — same as `getUserFileAbsolutePath`, the route's own `res.sendFile()` call surfaces a missing file as its own 404, nothing extra to do here. */
  getSiteLogoAbsolutePath(kind: SiteImageKind): string {
    return this.siteLogoPath(kind);
  }

  /** Байты текущей картинки сайта или null, если её нет. */
  async readSiteLogo(kind: SiteImageKind): Promise<Buffer | null> {
    return fs.readFile(this.siteLogoPath(kind)).catch(() => null);
  }

  // ---------------------------------------------------------------------
  // Tile sets — themed image options for the page-icon picker
  // (PageIconPicker), alongside the plain emoji list already there. Not
  // admin-uploaded through the app; placed directly on disk by whoever
  // deploys/manages the server, under `storageRoot/tile-sets/`, as
  // either kind:
  //   - a sprite sheet: `{name}.png`, a 4x5 grid of 64x64 tiles (20
  //     tiles per sheet, indices "0" through "19");
  //   - a folder of already-cut individual tiles: `{name}/`, any number
  //     of image files, each somewhere from 64x64 to 128x128 — served
  //     as-is, not resized server-side, since the picker's own CSS
  //     already constrains display size regardless of source dimensions.
  // Reading is public (no requireAuth) — same reasoning as the site
  // logo/name: these are shared, non-sensitive decorative images, not
  // tied to any one user's private data, and a page's icon needs to be
  // visible to everyone who can see the page, not just its owner.
  // ---------------------------------------------------------------------

  private static readonly TILE_IMAGE_EXTENSIONS = /\.(png|jpe?g|webp)$/i;

  private tileSetsDir(): string {
    return joinSafe(this.root, 'tile-sets');
  }

  /**
   * One entry per discovered set, sprite-sheet or folder alike — the
   * caller (ultimately the picker UI) doesn't need to know which kind a
   * set is, just which `tileIds` exist for it. For a sprite sheet these
   * are the strings "0"..String(cols*rows - 1) (crop-region indices,
   * per the configured grid — see FsEngineOptions.tileSheetCols/Rows);
   * for a folder these are the actual filenames. Empty array, not an
   * error, if the tile-sets folder doesn't exist at all yet.
   */
  async listTileSets(): Promise<{ name: string; tileIds: string[] }[]> {
    const dir = this.tileSetsDir();
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return [];
      throw new FsEngineError(`Failed to list tile sets: ${dir}`, 'IO_ERROR', err);
    }

    const sets: { name: string; tileIds: string[] }[] = [];
    const spriteSheetNames = new Set<string>();
    const tileCount = this.tileSheetCols * this.tileSheetRows;

    // Sprite sheets processed first, and their names recorded — a
    // folder sharing the same name is skipped below, matching
    // resolveTile()'s own precedence exactly (it always checks for the
    // sprite sheet first). Without this, a name collision would list
    // *two* entries under the same tab name, and picking a tile from
    // the folder-interpreted one would silently fail to resolve (its
    // filenames aren't valid sprite-sheet indices, which is what
    // resolveTile would actually try to use them as).
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
        const name = entry.name.slice(0, -'.png'.length);
        spriteSheetNames.add(name);
        sets.push({ name, tileIds: Array.from({ length: tileCount }, (_, i) => String(i)) });
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !spriteSheetNames.has(entry.name)) {
        const files = await fs.readdir(joinSafe(dir, entry.name)).catch(() => [] as string[]);
        const imageFiles = files.filter((f) => FsEngine.TILE_IMAGE_EXTENSIONS.test(f)).sort();
        if (imageFiles.length > 0) sets.push({ name: entry.name, tileIds: imageFiles });
      }
    }
    return sets;
  }

  /**
   * Resolves one tile to however it actually needs to be served — a
   * crop region within a sprite sheet, or a direct file path within a
   * folder set. The route handler doesn't need to know which kind
   * `setName` is up front, just what to do with whichever result comes
   * back. Returns null for anything that doesn't resolve (unknown set,
   * tileId not found within it, index out of range) — turning that into
   * a 404 is the route's own job, not this layer's.
   *
   * The sprite-sheet branch's result includes `cols`/`tileSize` — the
   * route computing the actual crop region reads the grid layout from
   * here rather than keeping its own separate copy of the config, so
   * there's exactly one place (this engine's constructor options) that
   * can disagree with itself.
   */
  async resolveTile(
    setName: string,
    tileId: string,
  ): Promise<
    | { kind: 'sprite-sheet'; absolutePath: string; index: number; cols: number; tileSize: number }
    | { kind: 'file'; absolutePath: string }
    | null
  > {
    const safeName = sanitizeFileName(setName);

    const spriteSheetPath = joinSafe(this.tileSetsDir(), `${safeName}.png`);
    if (await this.exists(spriteSheetPath)) {
      const index = Number(tileId);
      const tileCount = this.tileSheetCols * this.tileSheetRows;
      if (!Number.isInteger(index) || index < 0 || index >= tileCount) return null;
      return { kind: 'sprite-sheet', absolutePath: spriteSheetPath, index, cols: this.tileSheetCols, tileSize: this.tileSize };
    }

    const folderPath = joinSafe(this.tileSetsDir(), safeName);
    if (await this.exists(folderPath)) {
      const filePath = joinSafe(folderPath, sanitizeFileName(tileId));
      if (await this.exists(filePath)) return { kind: 'file', absolutePath: filePath };
    }

    return null;
  }

  // ---------------------------------------------------------------------
  // Users
  //
  // Папка пользователя — `users/{id}` (действующие) или `dismissed/{id}`
  // (уволенные: «Уволить» в админке переносит туда всю папку целиком).
  // Все пути к данным пользователя строятся через userRoot(), поэтому
  // ссылки вида /api/files/serve/{id}/… и /?owner={id}&… продолжают
  // работать после переноса — в адресах нет физического расположения.
  // ---------------------------------------------------------------------

  private dismissedIds: Set<string> | null = null;

  private dismissedSet(): Set<string> {
    if (!this.dismissedIds) {
      try {
        this.dismissedIds = new Set(
          readdirSync(joinSafe(this.root, 'dismissed'), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name),
        );
      } catch {
        this.dismissedIds = new Set();
      }
    }
    return this.dismissedIds;
  }

  /** Пользователь уволен — его папка лежит в `dismissed/`. */
  isDismissed(userId: string): boolean {
    return this.dismissedSet().has(userId);
  }

  /** Абсолютный путь к папке пользователя (действующего или уволенного). */
  private userRoot(userId: string): string {
    assertSafeId(userId, 'userId');
    return joinSafe(this.root, this.isDismissed(userId) ? 'dismissed' : 'users', userId);
  }

  /** Путь к папке пользователя относительно STORAGE_ROOT — для админки («где это на диске»). */
  userFolderRelative(userId: string): string {
    return `${this.isDismissed(userId) ? 'dismissed' : 'users'}/${assertSafeId(userId, 'userId')}`;
  }

  /** id всех пользователей, у которых есть папка — действующих и уволенных. */
  private async allUserIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const base of ['users', 'dismissed']) {
      const dir = joinSafe(this.root, base);
      if (!(await this.exists(dir))) continue;
      for (const e of await fs.readdir(dir, { withFileTypes: true })) if (e.isDirectory()) ids.push(e.name);
    }
    return ids;
  }

  /** Creates a user's root folder. Called only from admin-invite flows. */
  async createUser(userId: string, meta: Omit<UserMeta, 'id' | 'createdAt' | 'avatarUrl' | 'accentColor' | 'enabled'>): Promise<UserMeta> {
    assertSafeId(userId, 'userId');
    const userDir = joinSafe(this.root, 'users', userId);

    if (await this.exists(userDir)) {
      throw new FsEngineError(`User already exists: ${userId}`, 'ALREADY_EXISTS');
    }

    await fs.mkdir(userDir, { recursive: true });

    const fullMeta: UserMeta = { id: userId, createdAt: new Date().toISOString(), avatarUrl: null, accentColor: null, enabled: true, ...meta };
    await writeJsonAtomic(joinSafe(userDir, 'meta.json'), fullMeta);
    return fullMeta;
  }

  async getUser(userId: string): Promise<UserMeta> {
    assertSafeId(userId, 'userId');
    return normalizeUserMeta(await readJson<Partial<UserMeta>>(joinSafe(this.userRoot(userId), 'meta.json')));
  }

  /** Used by the one-time bootstrap-admin flow to check whether any account already exists. */
  async hasAnyUsers(): Promise<boolean> {
    const usersDir = joinSafe(this.root, 'users');
    if (!(await this.exists(usersDir))) return false;
    const entries = await fs.readdir(usersDir, { withFileTypes: true });
    return entries.some((e) => e.isDirectory());
  }

  /** Lists every user in the workspace (Admin panel). No pagination — fine at admin-panel scale. */
  async listUsers(): Promise<UserMeta[]> {
    const metas: UserMeta[] = [];
    for (const id of await this.allUserIds()) {
      try {
        metas.push(normalizeUserMeta(await readJson<Partial<UserMeta>>(joinSafe(this.userRoot(id), 'meta.json'))));
      } catch {
        // Skip a folder without a valid meta.json rather than failing the whole listing.
      }
    }
    return metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateUser(userId: string, patch: Partial<Pick<UserMeta, 'displayName' | 'role' | 'enabled'>>): Promise<UserMeta> {
    assertSafeId(userId, 'userId');
    const updated = await this.patchUserMeta(userId, patch);
    void this.writeUsersIndex().catch(() => undefined);
    return updated;
  }

  /**
   * Self-service profile changes — deliberately a *separate* method from
   * `updateUser`, not just the same method with a smaller patch type
   * passed in: `updateUser` is reachable from the admin routes (role,
   * displayName — things a user shouldn't grant themselves), this one is
   * reachable from a plain authenticated user acting on their own
   * account. Keeping them as two methods with two different patch types
   * means a route wiring mistake (accidentally exposing `updateUser` to
   * non-admins) is a type error, not just a missing runtime check.
   */
  async updateOwnProfile(userId: string, patch: Partial<Pick<UserMeta, 'avatarUrl' | 'accentColor'>>): Promise<UserMeta> {
    assertSafeId(userId, 'userId');
    const metaPath = joinSafe(this.userRoot(userId), 'meta.json');
    return lockManager.run(metaPath, async () => {
      const meta = normalizeUserMeta(await readJson<Partial<UserMeta>>(metaPath));
      const updated: UserMeta = { ...meta, ...patch };
      await writeJsonAtomic(metaPath, updated);
      return updated;
    });
  }

  /**
   * Удаляет пользователя полностью: папку (страницы, история, файлы — где
   * бы она ни лежала, в users/ или dismissed/), учётные данные, публичные
   * ссылки на его файлы и записи в индексе использования файлов.
   */
  async deleteUser(userId: string): Promise<void> {
    assertSafeId(userId, 'userId');
    const userDir = this.userRoot(userId);
    await lockManager.run(userDir, async () => {
      await fs.rm(userDir, { recursive: true, force: true });
    });
    this.dismissedSet().delete(userId);
    await this.removeCredentialsForUser(userId);
    await this.updatePublicFileLinks((links) => {
      for (const [t, l] of Object.entries(links)) if (l.ownerId === userId) delete links[t];
    });
    if (await this.readFileRefs()) {
      await this.updateFileRefs((idx) => {
        for (const k of Object.keys(idx.files)) if (k.startsWith(`${userId}/`)) delete idx.files[k];
        for (const k of Object.keys(idx.pages)) if (k.startsWith(`${userId}/`)) delete idx.pages[k];
      });
    }
    await this.writeUsersIndex().catch(() => undefined);
  }

  /**
   * «Уволить»: переносит всю папку пользователя в `dismissed/{id}` и
   * запрещает вход. Документы и файлы остаются доступны тем, кому были
   * открыты (ссылки по id не меняются), удалять их может только админ
   * через файловый менеджер.
   */
  async dismissUser(userId: string): Promise<UserMeta> {
    assertSafeId(userId, 'userId');
    if (this.isDismissed(userId)) return this.getUser(userId);
    const from = joinSafe(this.root, 'users', userId);
    const to = joinSafe(this.root, 'dismissed', userId);
    if (!(await this.exists(from))) throw new FsEngineError(`User not found: ${userId}`, 'NOT_FOUND');
    await fs.mkdir(path.dirname(to), { recursive: true });
    await lockManager.run(from, async () => {
      await fs.rename(from, to);
    });
    this.dismissedSet().add(userId);
    const meta = await this.patchUserMeta(userId, { enabled: false, dismissedAt: new Date().toISOString() });
    await this.writeUsersIndex().catch(() => undefined);
    return meta;
  }

  /** Вернуть уволенного: папка обратно в `users/`, вход снова разрешён. */
  async restoreUser(userId: string): Promise<UserMeta> {
    assertSafeId(userId, 'userId');
    if (!this.isDismissed(userId)) return this.getUser(userId);
    const from = joinSafe(this.root, 'dismissed', userId);
    const to = joinSafe(this.root, 'users', userId);
    await lockManager.run(from, async () => {
      await fs.rename(from, to);
    });
    this.dismissedSet().delete(userId);
    const meta = await this.patchUserMeta(userId, { enabled: true, dismissedAt: null });
    await this.writeUsersIndex().catch(() => undefined);
    return meta;
  }

  private async patchUserMeta(userId: string, patch: Partial<UserMeta>): Promise<UserMeta> {
    const metaPath = joinSafe(this.userRoot(userId), 'meta.json');
    return lockManager.run(metaPath, async () => {
      const meta = normalizeUserMeta(await readJson<Partial<UserMeta>>(metaPath));
      const updated: UserMeta = { ...meta, ...patch };
      await writeJsonAtomic(metaPath, updated);
      return updated;
    });
  }

  /**
   * `STORAGE_ROOT/USERS.txt` — какая папка чья: id → имя, email, статус,
   * путь. Чтобы админ в консоли не гадал по UUID. Перезаписывается при
   * создании, изменении, увольнении и удалении пользователей и на старте.
   */
  async writeUsersIndex(): Promise<void> {
    const [users, creds] = await Promise.all([this.listUsers(), this.getAllCredentials().catch(() => ({}) as Record<string, { userId: string }>)]);
    const emailById = new Map<string, string>();
    for (const [email, c] of Object.entries(creds)) emailById.set(c.userId, email);
    const rows = users
      .map((u) => ({
        folder: this.userFolderRelative(u.id),
        name: u.displayName,
        email: emailById.get(u.id) ?? '—',
        status: u.dismissedAt ? `уволен ${u.dismissedAt.slice(0, 10)}` : u.enabled ? 'активен' : 'отключён',
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const lines = [
      '# Папки пользователей (файл создаётся автоматически, не редактируйте)',
      `# Обновлено: ${new Date().toISOString()}`,
      '',
      ...rows.map((r) => `${r.folder.padEnd(48)}  ${r.name}  <${r.email}>  [${r.status}]`),
      '',
    ];
    await fs.writeFile(joinSafe(this.root, 'USERS.txt'), lines.join('\n'), 'utf-8');
  }

  // ---------------------------------------------------------------------
  // Credentials — persisted on disk so restarting the server never locks
  // anyone out. Kept separate from UserMeta (which has no email field) so
  // that document-storage code never needs to touch password hashes.
  // ---------------------------------------------------------------------

  private credentialsPath(): string {
    return joinSafe(this.root, 'auth', 'credentials.json');
  }

  async getAllCredentials(): Promise<Record<string, { userId: string; passwordHash: string }>> {
    try {
      return await readJson<Record<string, { userId: string; passwordHash: string }>>(this.credentialsPath());
    } catch (err) {
      if (err instanceof FsEngineError && err.code === 'NOT_FOUND') return {};
      throw err;
    }
  }

  async getCredentialByEmail(email: string): Promise<{ userId: string; passwordHash: string } | null> {
    const all = await this.getAllCredentials();
    return all[email.toLowerCase()] ?? null;
  }

  async setCredential(email: string, userId: string, passwordHash: string): Promise<void> {
    const filePath = this.credentialsPath();
    await lockManager.run(filePath, async () => {
      await fs.mkdir(joinSafe(this.root, 'auth'), { recursive: true });
      const all = await this.getAllCredentials();
      all[email.toLowerCase()] = { userId, passwordHash };
      await writeJsonAtomic(filePath, all);
    });
    void this.writeUsersIndex().catch(() => undefined);
  }

  async removeCredentialsForUser(userId: string): Promise<void> {
    const filePath = this.credentialsPath();
    await lockManager.run(filePath, async () => {
      const all = await this.getAllCredentials();
      let changed = false;
      for (const email of Object.keys(all)) {
        if (all[email]?.userId === userId) {
          delete all[email];
          changed = true;
        }
      }
      if (changed) {
        await fs.mkdir(joinSafe(this.root, 'auth'), { recursive: true });
        await writeJsonAtomic(filePath, all);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------

  async createProject(ownerId: string, name: string): Promise<ProjectMeta> {
    assertSafeId(ownerId, 'ownerId');
    const projectId = randomUUID();
    const projectDir = joinSafe(this.userRoot(ownerId), projectId);
    await fs.mkdir(joinSafe(projectDir, 'pages'), { recursive: true });

    const now = new Date().toISOString();
    const meta: ProjectMeta = { id: projectId, ownerId, name, icon: null, createdAt: now, updatedAt: now };
    await writeJsonAtomic(joinSafe(projectDir, 'meta.json'), meta);
    return meta;
  }

  async listProjects(ownerId: string): Promise<ProjectMeta[]> {
    assertSafeId(ownerId, 'ownerId');
    const userDir = this.userRoot(ownerId);
    if (!(await this.exists(userDir))) return [];

    const entries = await fs.readdir(userDir, { withFileTypes: true });
    const projects: ProjectMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        projects.push(await readJson<ProjectMeta>(joinSafe(userDir, entry.name, 'meta.json')));
      } catch {
        // Skip directories without a valid meta.json rather than failing the whole listing.
      }
    }
    return projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------

  private pagesDir(ownerId: string, projectId: string): string {
    return joinSafe(this.userRoot(assertSafeId(ownerId, 'ownerId')), assertSafeId(projectId, 'projectId'), 'pages');
  }

  private pageDir(ownerId: string, projectId: string, pageId: string): string {
    return joinSafe(this.pagesDir(ownerId, projectId), assertSafeId(pageId, 'pageId'));
  }

  /** A root page (parentId: null) is depth 0; its direct child is depth 1; a grandchild is depth 2. "Не более 2 вложений" means pages may go as deep as a grandchild, but no deeper. */
  private static readonly MAX_PAGE_NESTING_DEPTH = 2;

  private async getPageDepth(ownerId: string, projectId: string, pageId: string): Promise<number> {
    let depth = 0;
    let currentId: string | null = pageId;
    while (currentId) {
      const meta = await readPageMeta(joinSafe(this.pageDir(ownerId, projectId, currentId), 'meta.json'));
      currentId = meta.parentId;
      if (currentId) depth += 1;
    }
    return depth;
  }

  async createPage(
    ownerId: string,
    projectId: string,
    input: { title: string; parentId?: string | null; authorId: string; icon?: string | null },
  ): Promise<PageMeta> {
    if (input.parentId) {
      const parentDepth = await this.getPageDepth(ownerId, projectId, input.parentId);
      if (parentDepth >= FsEngine.MAX_PAGE_NESTING_DEPTH) {
        throw new FsEngineError(
          `Достигнута максимальная глубина вложенности страниц (${FsEngine.MAX_PAGE_NESTING_DEPTH} уровня)`,
          'INVALID_INPUT',
        );
      }
    }

    const pageId = randomUUID();
    const dir = this.pageDir(ownerId, projectId, pageId);

    return lockManager.run(dir, async () => {
      await fs.mkdir(joinSafe(dir, '.history'), { recursive: true });
      await fs.mkdir(joinSafe(dir, '.assets'), { recursive: true });

      const now = new Date().toISOString();
      const meta: PageMeta = {
        id: pageId,
        projectId,
        ownerId,
        parentId: input.parentId ?? null,
        title: input.title || 'Untitled',
        icon: input.icon ?? null,
        coverImage: null,
        order: Date.now(),
        createdAt: now,
        updatedAt: now,
        updatedBy: input.authorId,
        sharing: [],
        isArchived: false,
        tags: [],
      };

      await writeJsonAtomic(joinSafe(dir, 'meta.json'), meta);
      const emptyContent: PageContent = { blocks: [{ id: randomUUID(), type: 'paragraph', content: '' }] };
      await writeJsonAtomic(joinSafe(dir, 'content.json'), emptyContent);

      return meta;
    });
  }

  async getPageMeta(ownerId: string, projectId: string, pageId: string): Promise<PageMeta> {
    return readPageMeta(joinSafe(this.pageDir(ownerId, projectId, pageId), 'meta.json'));
  }

  async getPageContent(ownerId: string, projectId: string, pageId: string): Promise<PageContent> {
    return readJson<PageContent>(joinSafe(this.pageDir(ownerId, projectId, pageId), 'content.json'));
  }

  // ---------------------------------------------------------------------
  // Comments — one flat list per page, colocated in the page's own
  // directory (comments.jsonl next to meta.json/content.json).
  // ---------------------------------------------------------------------

  private commentsPath(ownerId: string, projectId: string, pageId: string): string {
    return joinSafe(this.pageDir(ownerId, projectId, pageId), 'comments.jsonl');
  }

  async listComments(ownerId: string, projectId: string, pageId: string): Promise<Comment[]> {
    return this.readAllComments(this.commentsPath(ownerId, projectId, pageId));
  }

  async addComment(ownerId: string, projectId: string, pageId: string, authorId: string, text: string): Promise<Comment> {
    const comment: Comment = {
      id: randomUUID(),
      authorId,
      text,
      createdAt: new Date().toISOString(),
      editedAt: null,
      reactions: {},
    };
    const filePath = this.commentsPath(ownerId, projectId, pageId);
    await lockManager.run(filePath, async () => {
      await fs.appendFile(filePath, JSON.stringify(comment) + '\n', 'utf-8');
    });
    return comment;
  }

  /** Only the author may edit their own comment. */
  async editComment(ownerId: string, projectId: string, pageId: string, commentId: string, authorId: string, text: string): Promise<Comment> {
    const filePath = this.commentsPath(ownerId, projectId, pageId);
    return lockManager.run(filePath, async () => {
      const comments = await this.readAllComments(filePath);
      const idx = comments.findIndex((c) => c.id === commentId);
      const target = comments[idx];
      if (idx === -1 || !target) throw new FsEngineError(`Comment ${commentId} not found`, 'NOT_FOUND');
      if (target.authorId !== authorId) throw new FsEngineError('Only the author can edit this comment', 'FORBIDDEN_PATH');

      const updated: Comment = { ...target, text, editedAt: new Date().toISOString() };
      comments[idx] = updated;
      await this.writeAllComments(filePath, comments);
      return updated;
    });
  }

  /**
   * Only the author may delete their own comment — always a true
   * removal, never a placeholder. Unlike chat messages, comments have no
   * threading, so there's nothing that could reference a deleted
   * comment's id and become orphaned by removing it outright.
   */
  async deleteComment(ownerId: string, projectId: string, pageId: string, commentId: string, authorId: string): Promise<void> {
    const filePath = this.commentsPath(ownerId, projectId, pageId);
    await lockManager.run(filePath, async () => {
      const comments = await this.readAllComments(filePath);
      const idx = comments.findIndex((c) => c.id === commentId);
      const target = comments[idx];
      if (idx === -1 || !target) throw new FsEngineError(`Comment ${commentId} not found`, 'NOT_FOUND');
      if (target.authorId !== authorId) throw new FsEngineError('Only the author can delete this comment', 'FORBIDDEN_PATH');

      comments.splice(idx, 1);
      await this.writeAllComments(filePath, comments);
    });
  }

  /** Any user with at least comment-level access may react — not author-only, same as chat reactions. */
  async toggleCommentReaction(
    ownerId: string,
    projectId: string,
    pageId: string,
    commentId: string,
    userId: string,
    emoji: string,
  ): Promise<Comment> {
    const filePath = this.commentsPath(ownerId, projectId, pageId);
    return lockManager.run(filePath, async () => {
      const comments = await this.readAllComments(filePath);
      const idx = comments.findIndex((c) => c.id === commentId);
      const target = comments[idx];
      if (idx === -1 || !target) throw new FsEngineError(`Comment ${commentId} not found`, 'NOT_FOUND');

      const current = target.reactions[emoji] ?? [];
      const alreadyReacted = current.includes(userId);
      const nextUsers = alreadyReacted ? current.filter((id) => id !== userId) : [...current, userId];

      const nextReactions = { ...target.reactions };
      if (nextUsers.length > 0) nextReactions[emoji] = nextUsers;
      else delete nextReactions[emoji];

      const updated: Comment = { ...target, reactions: nextReactions };
      comments[idx] = updated;
      await this.writeAllComments(filePath, comments);
      return updated;
    });
  }

  private async readAllComments(filePath: string): Promise<Comment[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => normalizeComment(JSON.parse(line) as Partial<Comment>));
    } catch {
      return [];
    }
  }

  private async writeAllComments(filePath: string, comments: Comment[]): Promise<void> {
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    const content = comments.map((c) => JSON.stringify(c)).join('\n') + (comments.length > 0 ? '\n' : '');
    try {
      await fs.writeFile(tmpPath, content, 'utf-8');
      await fs.rename(tmpPath, filePath); // atomic on the same filesystem
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }
  }

  /**
   * Persists new content for a page and writes a history snapshot.
   * The client hook (`useDocument`) debounces calls to this by ~3s, but the
   * engine itself does not assume any call frequency — it is safe to call
   * on every keystroke too.
   */
  async savePageContent(
    ownerId: string,
    projectId: string,
    pageId: string,
    content: PageContent,
    authorId: string,
  ): Promise<{ meta: PageMeta; snapshot: HistorySnapshot }> {
    const dir = this.pageDir(ownerId, projectId, pageId);

    return lockManager.run(dir, async () => {
      const metaPath = joinSafe(dir, 'meta.json');
      const contentPath = joinSafe(dir, 'content.json');

      const meta = await readPageMeta(metaPath);

      // Snapshot the *previous* content before overwriting, so `.history`
      // always holds recoverable prior states.
      const snapshot = await this.writeHistorySnapshot(dir, authorId);

      await writeJsonAtomic(contentPath, content);

      const updatedMeta: PageMeta = { ...meta, updatedAt: new Date().toISOString(), updatedBy: authorId };
      await writeJsonAtomic(metaPath, updatedMeta);

      // Какие файлы из личных хранилищ вставлены в страницу — от этого
      // зависит доступ к ним по прямой ссылке (см. updatePageFileRefs).
      await this.updatePageFileRefs(ownerId, projectId, pageId, content);

      return { meta: updatedMeta, snapshot };
    });
  }

  /**
   * Overwrites the sharing list for a page — grants/revokes access for
   * specific users (or `'*'` for "anyone with the link"). Callers are
   * responsible for authorization (only the owner, an Admin, or someone
   * already holding an `'admin'`-level grant may call this — enforced in
   * the route handler, see `storage.routes.ts`).
   */
  async updatePageSharing(
    ownerId: string,
    projectId: string,
    pageId: string,
    sharing: PageMeta['sharing'],
    authorId: string,
  ): Promise<PageMeta> {
    const dir = this.pageDir(ownerId, projectId, pageId);
    return lockManager.run(dir, async () => {
      const metaPath = joinSafe(dir, 'meta.json');
      const meta = await readPageMeta(metaPath);
      const updated: PageMeta = { ...meta, sharing, updatedAt: new Date().toISOString(), updatedBy: authorId };
      await writeJsonAtomic(metaPath, updated);
      return updated;
    });
  }

  /**
   * Scans every other user's projects for pages shared with `viewerId`
   * (directly or via a `'*'` "anyone with the link" grant). Powers the
   * "Shared with me" page. Fine at workspace scale; if this becomes a
   * bottleneck, maintain a reverse index (`shared-with/{viewerId}.json`)
   * updated incrementally by `updatePageSharing` instead of scanning.
   */
  async listSharedPages(viewerId: string): Promise<PageNode[]> {
    // Включая уволенных: их страницы остаются у тех, кому были открыты.
    const results: PageNode[] = [];

    for (const ownerId of await this.allUserIds()) {
      if (ownerId === viewerId) continue; // "shared with me" excludes my own pages

      let projects: ProjectMeta[];
      try {
        projects = await this.listProjects(ownerId);
      } catch {
        continue;
      }

      for (const project of projects) {
        let tree: PageNode[];
        try {
          tree = await this.listPages(ownerId, project.id);
        } catch {
          continue;
        }

        const flat: PageNode[] = [];
        const walk = (nodes: PageNode[]) => {
          for (const n of nodes) {
            flat.push(n);
            walk(n.children);
          }
        };
        walk(tree);

        for (const page of flat) {
          const grant = page.sharing.find((s) => s.userId === viewerId || s.userId === '*');
          if (grant) results.push(page);
        }
      }
    }

    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async renamePage(ownerId: string, projectId: string, pageId: string, title: string, authorId: string): Promise<PageMeta> {
    const dir = this.pageDir(ownerId, projectId, pageId);
    return lockManager.run(dir, async () => {
      const metaPath = joinSafe(dir, 'meta.json');
      const meta = await readPageMeta(metaPath);
      const updated: PageMeta = { ...meta, title, updatedAt: new Date().toISOString(), updatedBy: authorId };
      await writeJsonAtomic(metaPath, updated);
      return updated;
    });
  }

  /** `icon` is a raw emoji string (or null to reset to the default document icon the UI falls back to) — not validated against any fixed list here, the picker's 20 options live entirely on the frontend (lib/pageIcons.ts). */
  async updatePageIcon(ownerId: string, projectId: string, pageId: string, icon: string | null, authorId: string): Promise<PageMeta> {
    const dir = this.pageDir(ownerId, projectId, pageId);
    return lockManager.run(dir, async () => {
      const metaPath = joinSafe(dir, 'meta.json');
      const meta = await readPageMeta(metaPath);
      const updated: PageMeta = { ...meta, icon, updatedAt: new Date().toISOString(), updatedBy: authorId };
      await writeJsonAtomic(metaPath, updated);
      return updated;
    });
  }

  /**
   * `coverImage` holds either an asset URL (an image previously uploaded
   * via saveAsset — cover upload reuses that same mechanism rather than
   * a separate one) or a `color:#RRGGBB` string for a solid-color cover.
   * A plain string field distinguished by a prefix, same convention
   * already used for PageMeta.icon (emoji vs tile-set URL).
   */
  async updatePageCover(ownerId: string, projectId: string, pageId: string, coverImage: string | null, authorId: string): Promise<PageMeta> {
    const dir = this.pageDir(ownerId, projectId, pageId);
    return lockManager.run(dir, async () => {
      const metaPath = joinSafe(dir, 'meta.json');
      const meta = await readPageMeta(metaPath);
      const updated: PageMeta = { ...meta, coverImage, updatedAt: new Date().toISOString(), updatedBy: authorId };
      await writeJsonAtomic(metaPath, updated);
      return updated;
    });
  }

  /** Replaces the whole tag list — free-text, no fixed vocabulary or per-project registry to validate against (see PageMeta.tags's doc comment). Trims and drops empty/duplicate entries so a stray extra space or double-click doesn't silently create two visually-identical tags. */
  async updatePageTags(ownerId: string, projectId: string, pageId: string, tags: string[], authorId: string): Promise<PageMeta> {
    const dir = this.pageDir(ownerId, projectId, pageId);
    return lockManager.run(dir, async () => {
      const metaPath = joinSafe(dir, 'meta.json');
      const meta = await readPageMeta(metaPath);
      const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
      const updated: PageMeta = { ...meta, tags: cleaned, updatedAt: new Date().toISOString(), updatedBy: authorId };
      await writeJsonAtomic(metaPath, updated);
      return updated;
    });
  }

  /** Re-parents / reorders a page (drag-and-drop in the sidebar tree). */
  async movePage(
    ownerId: string,
    projectId: string,
    pageId: string,
    newParentId: string | null,
    newOrder: number,
    authorId: string,
  ): Promise<PageMeta> {
    if (newParentId) {
      const parentDepth = await this.getPageDepth(ownerId, projectId, newParentId);
      if (parentDepth >= FsEngine.MAX_PAGE_NESTING_DEPTH) {
        throw new FsEngineError(
          `Достигнута максимальная глубина вложенности страниц (${FsEngine.MAX_PAGE_NESTING_DEPTH} уровня)`,
          'INVALID_INPUT',
        );
      }
    }
    const dir = this.pageDir(ownerId, projectId, pageId);
    return lockManager.run(dir, async () => {
      const metaPath = joinSafe(dir, 'meta.json');
      const meta = await readPageMeta(metaPath);
      const updated: PageMeta = {
        ...meta,
        parentId: newParentId,
        order: newOrder,
        updatedAt: new Date().toISOString(),
        updatedBy: authorId,
      };
      await writeJsonAtomic(metaPath, updated);
      return updated;
    });
  }

  /**
   * Deletes a page AND every descendant page under it (matching by
   * `parentId`, since the on-disk layout is flat — hierarchy only exists
   * in each page's `meta.json`, not as nested folders). Deleting just the
   * target's own folder would leave children orphaned: still physically
   * on disk, but with a `parentId` pointing at nothing, which makes
   * `listPages()`'s tree-building silently skip them — invisible in the
   * UI forever, but never actually freed. Collect the full subtree first,
   * then remove each folder.
   */
  async deletePage(ownerId: string, projectId: string, pageId: string): Promise<void> {
    const descendantIds = await this.collectDescendantPageIds(ownerId, projectId, pageId);
    for (const id of [pageId, ...descendantIds]) {
      const dir = this.pageDir(ownerId, projectId, id);
      await lockManager.run(dir, async () => {
        await fs.rm(dir, { recursive: true, force: true });
      });
    }
  }

  private async collectDescendantPageIds(ownerId: string, projectId: string, rootId: string): Promise<string[]> {
    const pagesDir = this.pagesDir(ownerId, projectId);
    if (!(await this.exists(pagesDir))) return [];

    const entries = await fs.readdir(pagesDir, { withFileTypes: true });
    const metas: PageMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        metas.push(await readPageMeta(joinSafe(pagesDir, entry.name, 'meta.json')));
      } catch {
        // Skip a folder without a valid meta.json rather than failing the whole delete.
      }
    }

    const byParent = new Map<string, PageMeta[]>();
    for (const meta of metas) {
      if (meta.parentId === null) continue;
      const siblings = byParent.get(meta.parentId) ?? [];
      siblings.push(meta);
      byParent.set(meta.parentId, siblings);
    }

    const descendantIds: string[] = [];
    const walk = (parentId: string) => {
      for (const child of byParent.get(parentId) ?? []) {
        descendantIds.push(child.id);
        walk(child.id);
      }
    };
    walk(rootId);
    return descendantIds;
  }

  /** Builds the full page tree for a project by reading every page's meta.json. */
  async listPages(ownerId: string, projectId: string): Promise<PageNode[]> {
    const pagesDir = this.pagesDir(ownerId, projectId);
    if (!(await this.exists(pagesDir))) return [];

    const entries = await fs.readdir(pagesDir, { withFileTypes: true });
    const metas: PageMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        metas.push(await readPageMeta(joinSafe(pagesDir, entry.name, 'meta.json')));
      } catch {
        // Skip corrupted/partial page directories.
      }
    }

    const byParent = new Map<string | null, PageMeta[]>();
    for (const m of metas) {
      const list = byParent.get(m.parentId) ?? [];
      list.push(m);
      byParent.set(m.parentId, list);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);

    const build = (parentId: string | null): PageNode[] =>
      (byParent.get(parentId) ?? []).map((m) => ({ ...m, children: build(m.id) }));

    return build(null);
  }

  // ---------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------

  private async writeHistorySnapshot(pageDir: string, authorId: string): Promise<HistorySnapshot> {
    const contentPath = joinSafe(pageDir, 'content.json');
    const historyDir = joinSafe(pageDir, '.history');
    await fs.mkdir(historyDir, { recursive: true });

    let currentContent: string;
    try {
      currentContent = await fs.readFile(contentPath, 'utf-8');
    } catch {
      currentContent = JSON.stringify({ blocks: [] });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    // authorId (a UUID — only [a-zA-Z0-9-], survives sanitizeFileName
    // untouched) baked into the filename itself, `__` separator chosen
    // since UUIDs never contain underscores. This is what lets
    // listHistory report who saved each snapshot straight from a
    // directory listing, without reading every snapshot's full content
    // (up to `maxHistorySnapshots`, 200 by default) just to build a list.
    const file = `${timestamp}__${authorId}.json`;
    await fs.writeFile(joinSafe(historyDir, file), currentContent, 'utf-8');

    await this.pruneHistory(historyDir);

    return { timestamp, authorId, file };
  }

  private async pruneHistory(historyDir: string): Promise<void> {
    const files = (await fs.readdir(historyDir)).sort(); // ISO-like names sort chronologically
    const excess = files.length - this.maxHistorySnapshots;
    if (excess > 0) {
      await Promise.all(files.slice(0, excess).map((f) => fs.rm(joinSafe(historyDir, f), { force: true })));
    }
  }

  /** Parses `{timestamp}__{authorId}.json` back into a HistorySnapshot — a filename that doesn't match (e.g. hand-placed, or from before this encoding existed) still returns something usable, just with an empty authorId rather than throwing. */
  private parseHistoryFileName(file: string): HistorySnapshot {
    const match = file.match(/^(.+)__(.+)\.json$/);
    if (!match) return { timestamp: file.replace(/\.json$/, ''), authorId: '', file };
    const [, timestamp, authorId] = match;
    return { timestamp: timestamp ?? file, authorId: authorId ?? '', file };
  }

  async listHistory(ownerId: string, projectId: string, pageId: string): Promise<HistorySnapshot[]> {
    const historyDir = joinSafe(this.pageDir(ownerId, projectId, pageId), '.history');
    if (!(await this.exists(historyDir))) return [];
    const files = (await fs.readdir(historyDir)).sort().reverse(); // newest first
    return files.map((f) => this.parseHistoryFileName(f));
  }

  async getHistorySnapshot(ownerId: string, projectId: string, pageId: string, file: string): Promise<PageContent> {
    const safeFile = sanitizeFileName(file);
    return readJson<PageContent>(joinSafe(this.pageDir(ownerId, projectId, pageId), '.history', safeFile));
  }

  async restoreHistorySnapshot(
    ownerId: string,
    projectId: string,
    pageId: string,
    file: string,
    authorId: string,
  ): Promise<PageContent> {
    const content = await this.getHistorySnapshot(ownerId, projectId, pageId, file);
    await this.savePageContent(ownerId, projectId, pageId, content, authorId);
    return content;
  }

  // ---------------------------------------------------------------------
  // Assets (drag-and-drop uploads embedded in a page)
  // ---------------------------------------------------------------------

  async saveAsset(
    ownerId: string,
    projectId: string,
    pageId: string,
    originalFileName: string,
    data: Buffer,
    mimeType: string,
  ): Promise<AssetInfo> {
    const dir = this.pageDir(ownerId, projectId, pageId);
    const assetsDir = joinSafe(dir, '.assets');
    await fs.mkdir(assetsDir, { recursive: true });

    const safeName = sanitizeFileName(originalFileName);
    const uniqueName = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;
    const assetPath = joinSafe(assetsDir, uniqueName);

    await fs.writeFile(assetPath, data);

    return {
      fileName: uniqueName,
      relativePath: `/api/storage/${ownerId}/${projectId}/pages/${pageId}/assets/${uniqueName}`,
      size: data.byteLength,
      mimeType,
    };
  }

  /** Resolves the absolute, traversal-safe path to a previously saved asset, for the serving route. */
  getAssetAbsolutePath(ownerId: string, projectId: string, pageId: string, fileName: string): string {
    const safeName = sanitizeFileName(fileName);
    return joinSafe(this.pageDir(ownerId, projectId, pageId), '.assets', safeName);
  }

  // ---------------------------------------------------------------------
  // Personal file storage — one folder per user, independent of any single
  // page. This is what backs the "attach/insert existing file" picker in
  // the editor and the standalone concept of "each user has file storage".
  // ---------------------------------------------------------------------

  private userFilesDir(userId: string): string {
    return joinSafe(this.userRoot(userId), 'files');
  }

  private userFilesManifestPath(userId: string): string {
    return joinSafe(this.userFilesDir(userId), 'manifest.json');
  }

  private async readUserFilesManifest(userId: string): Promise<Record<string, UserFileManifestEntry>> {
    try {
      return await readJson<Record<string, UserFileManifestEntry>>(this.userFilesManifestPath(userId));
    } catch (err) {
      if (err instanceof FsEngineError && err.code === 'NOT_FOUND') return {};
      throw err;
    }
  }

  private toUserFileInfo(userId: string, fileName: string, e: UserFileManifestEntry): UserFileInfo {
    return {
      fileName,
      originalName: e.originalName,
      mimeType: e.mimeType,
      size: e.size,
      uploadedAt: e.uploadedAt,
      url: `/api/files/serve/${userId}/${fileName}`,
      ownerId: userId,
      sharedWith: e.sharedWith ?? [],
      publicToken: e.publicToken ?? null,
    };
  }

  async listUserFiles(userId: string): Promise<UserFileInfo[]> {
    const manifest = await this.readUserFilesManifest(userId);
    return Object.entries(manifest)
      .map(([fileName, info]) => this.toUserFileInfo(userId, fileName, info))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  /** Описание одного файла или null, если такого нет в манифесте. */
  async getUserFile(userId: string, fileName: string): Promise<UserFileInfo | null> {
    assertSafeId(userId, 'userId');
    const manifest = await this.readUserFilesManifest(userId);
    const e = manifest[fileName];
    return e ? this.toUserFileInfo(userId, fileName, e) : null;
  }

  /**
   * Сохраняет файл в личное хранилище. Имя на диске — всегда ASCII
   * (`{время}-{случайное}{.расширение}`), а исходное имя (с кириллицей и
   * т.п.) хранится в манифесте и отдаётся при скачивании.
   */
  async saveUserFile(userId: string, originalFileName: string, data: Buffer, mimeType: string): Promise<UserFileInfo> {
    assertSafeId(userId, 'userId');
    const dir = this.userFilesDir(userId);
    await fs.mkdir(dir, { recursive: true });

    const displayName = sanitizeDisplayFileName(originalFileName);
    const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}${safeExtension(displayName)}`;
    await fs.writeFile(joinSafe(dir, fileName), data);

    const entry: UserFileManifestEntry = { originalName: displayName, mimeType, size: data.byteLength, uploadedAt: new Date().toISOString() };
    const manifestPath = this.userFilesManifestPath(userId);
    await lockManager.run(manifestPath, async () => {
      const manifest = await this.readUserFilesManifest(userId);
      manifest[fileName] = entry;
      await writeJsonAtomic(manifestPath, manifest);
    });

    return this.toUserFileInfo(userId, fileName, entry);
  }

  async deleteUserFile(userId: string, fileName: string): Promise<void> {
    const safeName = sanitizeFileName(fileName);
    const dir = this.userFilesDir(userId);
    const manifestPath = this.userFilesManifestPath(userId);

    let token: string | null = null;
    await lockManager.run(manifestPath, async () => {
      await fs.rm(joinSafe(dir, safeName), { force: true });
      const manifest = await this.readUserFilesManifest(userId);
      if (manifest[safeName]) {
        token = manifest[safeName]!.publicToken ?? null;
        delete manifest[safeName];
        await writeJsonAtomic(manifestPath, manifest);
      }
    });
    if (token) await this.updatePublicFileLinks((links) => void delete links[token!]);
  }

  /** Resolves the absolute, traversal-safe path to a personal file, for the serving route. */
  getUserFileAbsolutePath(userId: string, fileName: string): string {
    const safeName = sanitizeFileName(fileName);
    return joinSafe(this.userFilesDir(userId), safeName);
  }

  private async patchUserFile(
    userId: string,
    fileName: string,
    fn: (e: UserFileManifestEntry) => void,
  ): Promise<UserFileInfo> {
    assertSafeId(userId, 'userId');
    const manifestPath = this.userFilesManifestPath(userId);
    return lockManager.run(manifestPath, async () => {
      const manifest = await this.readUserFilesManifest(userId);
      const e = manifest[fileName];
      if (!e) throw new FsEngineError(`File not found: ${fileName}`, 'NOT_FOUND');
      fn(e);
      await writeJsonAtomic(manifestPath, manifest);
      return this.toUserFileInfo(userId, fileName, e);
    });
  }

  /** Кому открыт доступ к файлу (id пользователей, '*' — всем сотрудникам). Полностью заменяет список. */
  async setUserFileSharing(userId: string, fileName: string, sharedWith: string[]): Promise<UserFileInfo> {
    const clean = [...new Set(sharedWith.filter((id) => id === '*' || /^[a-zA-Z0-9_-]{1,128}$/.test(id)))].filter((id) => id !== userId);
    return this.patchUserFile(userId, fileName, (e) => {
      e.sharedWith = clean;
    });
  }

  // ---- Файловый менеджер администратора ----------------------------------

  /** Суммарный размер папки на диске (рекурсивно, без перехода по ссылкам). */
  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await this.dirSize(p);
      else if (e.isFile()) total += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
    }
    return total;
  }

  /** Сводка для таблицы пользователей: файлы, документы, общий объём папки. */
  async getUserStorageSummary(userId: string): Promise<{ filesCount: number; filesBytes: number; pagesCount: number; totalBytes: number; folder: string }> {
    const files = await this.listUserFiles(userId).catch(() => []);
    const pages = await this.listUserPagesFlat(userId).catch(() => []);
    return {
      filesCount: files.length,
      filesBytes: files.reduce((s, f) => s + f.size, 0),
      pagesCount: pages.length,
      totalBytes: await this.dirSize(this.userRoot(userId)),
      folder: this.userFolderRelative(userId),
    };
  }

  /** Все страницы пользователя плоским списком (для админки): путь в дереве, проект, размер папки страницы. */
  async listUserPagesFlat(
    userId: string,
  ): Promise<
    { projectId: string; projectName: string; id: string; title: string; icon: string | null; path: string[]; updatedAt: string; bytes: number; ownFiles: number; children: number }[]
  > {
    const out: {
      projectId: string;
      projectName: string;
      id: string;
      title: string;
      icon: string | null;
      path: string[];
      updatedAt: string;
      bytes: number;
      ownFiles: number;
      children: number;
    }[] = [];
    const refs = await this.readFileRefs();
    const countAll = (n: PageNode): number => n.children.reduce((s2, c) => s2 + 1 + countAll(c), 0);
    for (const project of await this.listProjects(userId)) {
      const walk = async (nodes: PageNode[], trail: string[]) => {
        for (const n of nodes) {
          out.push({
            projectId: project.id,
            projectName: project.name,
            id: n.id,
            title: n.title,
            icon: n.icon,
            path: trail,
            updatedAt: n.updatedAt,
            bytes: await this.dirSize(this.pageDir(userId, project.id, n.id)),
            ownFiles: (refs?.pages[`${userId}/${project.id}/${n.id}`] ?? []).filter((k) => k.startsWith(`${userId}/`)).length,
            children: countAll(n),
          });
          await walk(n.children, [...trail, n.title || 'Без названия']);
        }
      };
      await walk(await this.listPages(userId, project.id).catch(() => []), []);
    }
    return out;
  }

  /**
   * Переносит документ (со всеми вложенными страницами) другому
   * пользователю — в его первый проект (или указанный), в корень дерева.
   * Папки страниц переезжают целиком (история, комментарии, вложения), id
   * страниц сохраняются. Обновляются: владелец/проект в meta, адреса
   * вложений страницы (/api/storage/…), ссылки на эти страницы из ВСЕХ
   * документов (/page-ref/…), разделы публичных сайтов и очередь заявок,
   * индекс использования файлов. Ссылки из чатов (pageRef) обновляет
   * вызывающий через ChatEngine.replacePageRefs по возвращённой карте.
   * `withFiles` — заодно перенести файлы прежнего владельца, вставленные
   * в эти документы (moveUserFile — со всеми ссылками).
   */
  async movePages(input: {
    fromUserId: string;
    projectId: string;
    pageId: string;
    toUserId: string;
    toProjectId?: string | null;
    actorId: string;
    withFiles?: boolean;
  }): Promise<{
    movedIds: string[];
    toProjectId: string;
    pageMoves: Map<string, { ownerId: string; projectId: string }>;
    fileMoves: { oldUrl: string; newUrl: string; chatIds: string[] }[];
  }> {
    const { fromUserId: from, projectId: proj, pageId, toUserId: to, actorId } = input;
    assertSafeId(from, 'userId');
    assertSafeId(to, 'userId');
    await this.getPageMeta(from, proj, pageId); // NOT_FOUND
    await this.getUser(to);

    let toProj = input.toProjectId ?? null;
    if (!toProj) {
      const projects = await this.listProjects(to);
      toProj = projects[0]?.id ?? (await this.createProject(to, 'Моё пространство')).id;
    }
    if (from === to && proj === toProj) return { movedIds: [], toProjectId: toProj, pageMoves: new Map(), fileMoves: [] };

    const ids = [pageId, ...(await this.collectDescendantPageIds(from, proj, pageId))];
    await fs.mkdir(this.pagesDir(to, toProj), { recursive: true });
    const rootOrder = Math.max(0, ...(await this.listPages(to, toProj).catch(() => [])).map((n) => n.order)) + 1;

    // 1. Папки страниц и meta.
    for (const id of ids) {
      const src = this.pageDir(from, proj, id);
      const dst = this.pageDir(to, toProj, id);
      await lockManager.run(src, async () => {
        await fs.rename(src, dst);
      });
      const metaPath = joinSafe(dst, 'meta.json');
      const meta = await readPageMeta(metaPath);
      const assetPrefixOld = `/api/storage/${from}/${proj}/pages/`;
      const assetPrefixNew = `/api/storage/${to}/${toProj}/pages/`;
      await writeJsonAtomic(metaPath, {
        ...meta,
        ownerId: to,
        projectId: toProj,
        ...(id === pageId ? { parentId: null, order: rootOrder } : {}),
        sharing: meta.sharing.filter((g) => g.userId !== to),
        coverImage: meta.coverImage ? meta.coverImage.split(assetPrefixOld).join(assetPrefixNew) : meta.coverImage,
      } satisfies PageMeta);
    }

    // 2. Тексты: вложения перенесённых страниц и ссылки на них из всех документов.
    const replacements: [string, string][] = [];
    for (const id of ids) {
      replacements.push([`/api/storage/${from}/${proj}/pages/${id}/`, `/api/storage/${to}/${toProj}/pages/${id}/`]);
      replacements.push([`/page-ref/${from}/${proj}/${id}`, `/page-ref/${to}/${toProj}/${id}`]);
    }
    for (const owner of await this.allUserIds()) {
      for (const project of await this.listProjects(owner).catch(() => [])) {
        const dir = this.pagesDir(owner, project.id);
        let entries: import('node:fs').Dirent[] = [];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const contentPath = joinSafe(dir, e.name, 'content.json');
          await lockManager.run(joinSafe(dir, e.name), async () => {
            let text: string;
            try {
              text = await fs.readFile(contentPath, 'utf-8');
            } catch {
              return;
            }
            let next = text;
            for (const [a, b] of replacements) if (next.includes(a)) next = next.split(a).join(b);
            if (next !== text) await writeJsonAtomic(contentPath, JSON.parse(next));
          });
        }
      }
    }

    // 3. Индекс использования файлов: ключи страниц.
    const pageMoves = new Map<string, { ownerId: string; projectId: string }>();
    for (const id of ids) pageMoves.set(`${from}/${proj}/${id}`, { ownerId: to, projectId: toProj });
    if (await this.readFileRefs()) {
      await this.updateFileRefs((idx) => {
        for (const id of ids) {
          const oldKey = `${from}/${proj}/${id}`;
          const newKey = `${to}/${toProj}/${id}`;
          const fileKeys = idx.pages[oldKey];
          if (!fileKeys) continue;
          delete idx.pages[oldKey];
          idx.pages[newKey] = fileKeys;
          for (const fk of fileKeys) idx.files[fk] = (idx.files[fk] ?? []).map((r) => (r === `page:${oldKey}` ? `page:${newKey}` : r));
        }
      });
    }

    // 4. Публичные сайты и очередь заявок.
    const idSet = new Set(ids);
    for (const site of await this.listPublicSites().catch(() => [])) {
      const filePath = this.publicSiteFilePath(site.id);
      await lockManager.run(filePath, async () => {
        const cur = await this.readPublicSiteFile(site.id);
        let changed = false;
        const nodes = cur.nodes.map((n) => {
          if (n.ownerId === from && n.projectId === proj && idSet.has(n.pageId)) {
            changed = true;
            return { ...n, ownerId: to, projectId: toProj! };
          }
          return n;
        });
        if (changed) await writeJsonAtomic(filePath, { site: cur.site, nodes });
      });
    }
    await lockManager.run(this.publicInboxPath(), async () => {
      const items = await this.readPublicInbox();
      let changed = false;
      const next = items.map((i) => {
        if (i.ownerId === from && i.projectId === proj && idSet.has(i.pageId)) {
          changed = true;
          return { ...i, ownerId: to, projectId: toProj! };
        }
        return i;
      });
      if (changed) await writeJsonAtomic(this.publicInboxPath(), { items: next });
    });

    // 5. Файлы прежнего владельца, вставленные в эти документы.
    const fileMoves: { oldUrl: string; newUrl: string; chatIds: string[] }[] = [];
    if (input.withFiles && from !== to) {
      const keys = new Set<string>();
      for (const id of ids) {
        const content = await this.getPageContent(to, toProj, id).catch(() => null);
        if (content) for (const k of FsEngine.extractUserFileKeys(JSON.stringify(content))) if (k.startsWith(`${from}/`)) keys.add(k);
      }
      for (const k of keys) {
        const fileName = k.slice(from.length + 1);
        const r = await this.moveUserFile(from, fileName, to, actorId).catch(() => null);
        if (r) fileMoves.push({ oldUrl: r.oldUrl, newUrl: r.newUrl, chatIds: r.chatIds });
      }
    }

    return { movedIds: ids, toProjectId: toProj, pageMoves, fileMoves };
  }

  /**
   * Переносит файл в каталог другого пользователя (админ). Файл физически
   * переезжает, адрес меняется на /api/files/serve/{новый владелец}/…, и
   * все ссылки на него переписываются: в страницах (через savePageContent —
   * со снимком истории) и в индексе использования; публичная ссылка /f/…
   * продолжает работать. Чаты возвращаются вызывающему (их ведёт @core/chat).
   */
  async moveUserFile(
    fromUserId: string,
    fileName: string,
    toUserId: string,
    actorId: string,
  ): Promise<{ file: UserFileInfo; oldUrl: string; newUrl: string; chatIds: string[] }> {
    assertSafeId(fromUserId, 'userId');
    assertSafeId(toUserId, 'userId');
    const safeName = sanitizeFileName(fileName);
    const src = await this.getUserFile(fromUserId, safeName);
    if (!src) throw new FsEngineError(`File not found: ${safeName}`, 'NOT_FOUND');
    if (fromUserId === toUserId) return { file: src, oldUrl: src.url, newUrl: src.url, chatIds: [] };
    await this.getUser(toUserId); // NOT_FOUND, если такого пользователя нет

    const targetDir = this.userFilesDir(toUserId);
    await fs.mkdir(targetDir, { recursive: true });
    const targetManifest = await this.readUserFilesManifest(toUserId);
    let newName = safeName;
    if (targetManifest[newName] || (await this.exists(joinSafe(targetDir, newName)))) {
      newName = `${Date.now()}-${randomUUID().slice(0, 8)}${safeExtension(safeName)}`;
    }

    // 1. Файл и записи в манифестах.
    let entry: UserFileManifestEntry | null = null;
    await lockManager.run(this.userFilesManifestPath(fromUserId), async () => {
      const m = await this.readUserFilesManifest(fromUserId);
      entry = m[safeName] ?? null;
      if (!entry) throw new FsEngineError(`File not found: ${safeName}`, 'NOT_FOUND');
      await fs.rename(joinSafe(this.userFilesDir(fromUserId), safeName), joinSafe(targetDir, newName));
      delete m[safeName];
      await writeJsonAtomic(this.userFilesManifestPath(fromUserId), m);
    });
    const moved: UserFileManifestEntry = { ...entry!, sharedWith: (entry!.sharedWith ?? []).filter((id) => id !== toUserId) };
    await lockManager.run(this.userFilesManifestPath(toUserId), async () => {
      const m = await this.readUserFilesManifest(toUserId);
      m[newName] = moved;
      await writeJsonAtomic(this.userFilesManifestPath(toUserId), m);
    });

    // 2. Публичная ссылка — тот же токен, новый файл.
    if (moved.publicToken) {
      const t = moved.publicToken;
      await this.updatePublicFileLinks((links) => {
        links[t] = { ownerId: toUserId, fileName: newName };
      });
    }

    const oldUrl = `/api/files/serve/${fromUserId}/${safeName}`;
    const newUrl = `/api/files/serve/${toUserId}/${newName}`;

    // 3. Аватар прежнего владельца больше не его файл.
    const fromMeta = await this.getUser(fromUserId).catch(() => null);
    if (fromMeta?.avatarUrl === oldUrl) await this.patchUserMeta(fromUserId, { avatarUrl: null });

    // 4. Ссылки в страницах и индекс использования.
    const refs = await this.getFileRefs(fromUserId, safeName);
    const chatIds: string[] = [];
    for (const ref of refs) {
      if (ref.startsWith('page:')) {
        const [owner, project, page] = ref.slice(5).split('/');
        if (!owner || !project || !page) continue;
        try {
          const content = await this.getPageContent(owner, project, page);
          const text = JSON.stringify(content);
          if (text.includes(oldUrl)) {
            await this.savePageContent(owner, project, page, JSON.parse(text.split(oldUrl).join(newUrl)) as PageContent, actorId);
          }
        } catch {
          /* страница удалена — пропускаем */
        }
      } else if (ref.startsWith('chat:')) {
        chatIds.push(ref.slice(5));
      }
    }
    if (chatIds.length) {
      const oldKey = `${fromUserId}/${safeName}`;
      const newKey = `${toUserId}/${newName}`;
      await this.updateFileRefs((idx) => {
        const chatRefs = (idx.files[oldKey] ?? []).filter((r) => r.startsWith('chat:'));
        idx.files[newKey] = [...new Set([...(idx.files[newKey] ?? []), ...chatRefs])];
        idx.files[oldKey] = (idx.files[oldKey] ?? []).filter((r) => !r.startsWith('chat:'));
        if (idx.files[oldKey]!.length === 0) delete idx.files[oldKey];
      });
    }

    return { file: this.toUserFileInfo(toUserId, newName, moved), oldUrl, newUrl, chatIds };
  }

  // ---- Публичные ссылки на файлы (/f/{token}) -----------------------------
  // Ссылка не раскрывает ни id владельца, ни имя файла на диске и
  // отзывается удалением токена. Индекс token → файл: storageRoot/file-public-links.json.

  private publicFileLinksPath(): string {
    return joinSafe(this.root, 'file-public-links.json');
  }

  private async readPublicFileLinks(): Promise<Record<string, { ownerId: string; fileName: string }>> {
    try {
      return await readJson<Record<string, { ownerId: string; fileName: string }>>(this.publicFileLinksPath());
    } catch (err) {
      if (err instanceof FsEngineError && err.code === 'NOT_FOUND') return {};
      throw err;
    }
  }

  private async updatePublicFileLinks(fn: (links: Record<string, { ownerId: string; fileName: string }>) => void): Promise<void> {
    const p = this.publicFileLinksPath();
    await lockManager.run(p, async () => {
      const links = await this.readPublicFileLinks();
      fn(links);
      await writeJsonAtomic(p, links);
    });
  }

  /** Включает публичную ссылку (или возвращает существующую). */
  async enableUserFilePublicLink(userId: string, fileName: string): Promise<UserFileInfo> {
    const current = await this.getUserFile(userId, fileName);
    if (!current) throw new FsEngineError(`File not found: ${fileName}`, 'NOT_FOUND');
    if (current.publicToken) return current;
    const token = randomBytes(18).toString('base64url');
    await this.updatePublicFileLinks((links) => {
      links[token] = { ownerId: userId, fileName };
    });
    return this.patchUserFile(userId, fileName, (e) => {
      e.publicToken = token;
    });
  }

  /** Отзывает публичную ссылку — старый адрес /f/{token} перестаёт работать. */
  async disableUserFilePublicLink(userId: string, fileName: string): Promise<UserFileInfo> {
    const current = await this.getUserFile(userId, fileName);
    if (!current) throw new FsEngineError(`File not found: ${fileName}`, 'NOT_FOUND');
    if (current.publicToken) {
      const t = current.publicToken;
      await this.updatePublicFileLinks((links) => void delete links[t]);
    }
    return this.patchUserFile(userId, fileName, (e) => {
      e.publicToken = null;
    });
  }

  /** Файл по токену публичной ссылки, или null (ссылка отозвана / файл удалён). */
  async resolvePublicFileToken(token: string): Promise<UserFileInfo | null> {
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return null;
    const link = (await this.readPublicFileLinks())[token];
    if (!link) return null;
    const file = await this.getUserFile(link.ownerId, link.fileName).catch(() => null);
    return file && file.publicToken === token ? file : null;
  }

  /** Файлы других пользователей, к которым открыт доступ этому пользователю (лично или «всем сотрудникам»). */
  async listFilesSharedWithUser(userId: string): Promise<UserFileInfo[]> {
    const users = await this.listUsers();
    const result: UserFileInfo[] = [];
    for (const u of users) {
      if (u.id === userId) continue;
      const files = await this.listUserFiles(u.id).catch(() => []);
      for (const f of files) if (f.sharedWith.includes(userId) || f.sharedWith.includes('*')) result.push(f);
    }
    return result.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  // ---- Где используются файлы (страницы, чаты) ---------------------------
  // Индекс storageRoot/file-refs.json: для каждого файла — где он вставлен
  // (`page:…`/`chat:…`), и обратный — какие файлы в какой странице. По
  // нему files.routes.ts решает, может ли человек открыть файл по прямой
  // ссылке: картинка в расшаренной странице видна тем, кому открыта
  // страница; вложение в чате — участникам чата; картинка в
  // опубликованной странице — всем.

  private fileRefsPath(): string {
    return joinSafe(this.root, 'file-refs.json');
  }

  private async readFileRefs(): Promise<{ v: number; files: Record<string, FileRef[]>; pages: Record<string, string[]> } | null> {
    try {
      return await readJson(this.fileRefsPath());
    } catch (err) {
      if (err instanceof FsEngineError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  private async updateFileRefs(fn: (idx: { v: number; files: Record<string, FileRef[]>; pages: Record<string, string[]> }) => void) {
    const p = this.fileRefsPath();
    await lockManager.run(p, async () => {
      const idx = (await this.readFileRefs()) ?? { v: 1, files: {}, pages: {} };
      fn(idx);
      await writeJsonAtomic(p, idx);
    });
  }

  /** Ключи файлов (`{userId}/{fileName}`), на которые есть ссылки в тексте/блоках. */
  static extractUserFileKeys(text: string): string[] {
    const keys = new Set<string>();
    for (const m of text.matchAll(/\/api\/files\/serve\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9._-]{1,255})/g)) keys.add(`${m[1]}/${m[2]}`);
    return [...keys];
  }

  private static setPageRefs(
    idx: { files: Record<string, FileRef[]>; pages: Record<string, string[]> },
    pageKey: string,
    fileKeys: string[],
  ) {
    const ref = `page:${pageKey}`;
    for (const old of idx.pages[pageKey] ?? []) {
      idx.files[old] = (idx.files[old] ?? []).filter((r) => r !== ref);
      if (idx.files[old]!.length === 0) delete idx.files[old];
    }
    if (fileKeys.length) idx.pages[pageKey] = fileKeys;
    else delete idx.pages[pageKey];
    for (const k of fileKeys) idx.files[k] = [...new Set([...(idx.files[k] ?? []), ref])];
  }

  /** Обновляет индекс после сохранения содержимого страницы. */
  async updatePageFileRefs(ownerId: string, projectId: string, pageId: string, content: PageContent): Promise<void> {
    const keys = FsEngine.extractUserFileKeys(JSON.stringify(content.blocks ?? []));
    await this.updateFileRefs((idx) => FsEngine.setPageRefs(idx, `${ownerId}/${projectId}/${pageId}`, keys));
  }

  /** Отмечает, что файл прикреплён к сообщению в чате. */
  async addChatFileRef(chatId: string, url: string): Promise<void> {
    const keys = FsEngine.extractUserFileKeys(url);
    if (!keys.length) return;
    await this.updateFileRefs((idx) => {
      for (const k of keys) idx.files[k] = [...new Set([...(idx.files[k] ?? []), `chat:${chatId}`])];
    });
  }

  /**
   * Удаляет голосовые и кружки, записанные в чате, на которые больше нет
   * ни одной ссылки (сообщения удалили до версии, где файл удалялся
   * вместе с сообщением). Узнаём их по имени «Голосовое …» / «Кружок …» и
   * типу audio/* или video/*. Возвращает число удалённых файлов.
   */
  async cleanupOrphanRecordings(chatAttachmentUrls: Set<string>): Promise<number> {
    const refs = await this.readFileRefs();
    if (!refs) return 0;
    let removed = 0;
    for (const userId of await this.allUserIds()) {
      for (const f of await this.listUserFiles(userId).catch(() => [] as UserFileInfo[])) {
        if (!/^(Голосовое|Кружок) \d{4}-\d{2}-\d{2} /.test(f.originalName)) continue;
        if (!/^(audio|video)\//.test(f.mimeType)) continue;
        // Ссылки на чаты в индексе могли остаться от старых удалений — сверяемся с самими сообщениями.
        if (chatAttachmentUrls.has(f.url)) continue;
        if ((refs.files[`${userId}/${f.fileName}`] ?? []).some((r) => !r.startsWith('chat:'))) continue;
        await this.deleteUserFile(userId, f.fileName).catch(() => undefined);
        await this.updateFileRefs((idx) => {
          delete idx.files[`${userId}/${f.fileName}`];
        });
        removed++;
      }
    }
    return removed;
  }

  /** Файл больше не прикреплён ни к одному сообщению этого чата. */
  async removeChatFileRef(chatId: string, url: string): Promise<void> {
    const keys = FsEngine.extractUserFileKeys(url);
    if (!keys.length) return;
    await this.updateFileRefs((idx) => {
      for (const k of keys) {
        const left = (idx.files[k] ?? []).filter((r) => r !== `chat:${chatId}`);
        if (left.length) idx.files[k] = left;
        else delete idx.files[k];
      }
    });
  }

  async getFileRefs(ownerId: string, fileName: string): Promise<FileRef[]> {
    return (await this.readFileRefs())?.files[`${ownerId}/${fileName}`] ?? [];
  }

  /**
   * Однократное построение индекса по всем существующим страницам и
   * переданным вложениям чатов — при первом запуске версии, где индекс
   * появился. Если индекс уже есть, ничего не делает.
   */
  async backfillFileRefs(chatAttachments: { chatId: string; url: string }[]): Promise<boolean> {
    if (await this.readFileRefs()) return false;
    const idx = { v: 1, files: {} as Record<string, FileRef[]>, pages: {} as Record<string, string[]> };
    for (const u of await this.listUsers()) {
      for (const project of await this.listProjects(u.id).catch(() => [])) {
        const walk = async (nodes: PageNode[]) => {
          for (const n of nodes) {
            try {
              const content = await this.getPageContent(u.id, project.id, n.id);
              FsEngine.setPageRefs(idx, `${u.id}/${project.id}/${n.id}`, FsEngine.extractUserFileKeys(JSON.stringify(content.blocks ?? [])));
            } catch {
              /* страница без content.json — пропускаем */
            }
            await walk(n.children);
          }
        };
        await walk(await this.listPages(u.id, project.id).catch(() => []));
      }
    }
    for (const a of chatAttachments) {
      for (const k of FsEngine.extractUserFileKeys(a.url)) idx.files[k] = [...new Set([...(idx.files[k] ?? []), `chat:${a.chatId}`])];
    }
    await lockManager.run(this.fileRefsPath(), () => writeJsonAtomic(this.fileRefsPath(), idx));
    return true;
  }

  // ---------------------------------------------------------------------
  // Search (naive content scan — production would delegate to Fuse/Lunr index)
  // ---------------------------------------------------------------------

  /** Shared by `searchPages` (one project, full access assumed — the caller already owns it) and `searchVisiblePages` (every project the viewer can see, including others' shared pages) — one place deciding what "matches" means for both. */
  private async pageMatchesQuery(ownerId: string, projectId: string, meta: PageMeta, needle: string): Promise<boolean> {
    if (meta.title.toLowerCase().includes(needle)) return true;
    try {
      const content = await this.getPageContent(ownerId, projectId, meta.id);
      const text = content.blocks.map((b) => stripHtmlForSearch(b.content)).join(' ').toLowerCase();
      return text.includes(needle);
    } catch {
      return false; // unreadable content — doesn't count as a match, doesn't fail the whole search either
    }
  }

  async searchPages(ownerId: string, projectId: string, query: string): Promise<PageMeta[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const tree = await this.listPages(ownerId, projectId);
    const flat: PageMeta[] = [];
    const walk = (nodes: PageNode[]) => {
      for (const n of nodes) {
        flat.push(n);
        walk(n.children);
      }
    };
    walk(tree);

    const matches: PageMeta[] = [];
    for (const meta of flat) {
      if (await this.pageMatchesQuery(ownerId, projectId, meta, needle)) matches.push(meta);
    }
    return matches;
  }

  /**
   * Same idea as `searchPages`, but across *every* page the viewer can
   * actually see — their own (every one of their own projects, not
   * just one) plus every other user's page that's been shared with them
   * specifically or with everyone (`sharing` entry for the viewer's own
   * id or `'*'`). Backs the "link to a document" picker's document-level
   * search: with many documents, and the same term potentially explained
   * in several of them, filtering *which* document to open by whether it
   * actually contains the term is the whole point — a plain alphabetical
   * list doesn't help find the right one.
   *
   * Traverses every other user's directory the same way
   * `listSharedPages` already does (this is deliberately *not* built by
   * calling that method and then filtering — reusing `pageMatchesQuery`
   * per page here avoids fetching + reading page content for entries
   * that don't even pass the sharing-grant check, which `listSharedPages`
   * itself doesn't need to care about since it's just listing, not
   * searching content).
   */
  async searchVisiblePages(viewerId: string, query: string): Promise<PageMeta[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const results: PageMeta[] = [];

    const ownProjects = await this.listProjects(viewerId).catch(() => []);
    for (const project of ownProjects) {
      results.push(...(await this.searchPages(viewerId, project.id, needle)));
    }

    {
      for (const ownerId of await this.allUserIds()) {
        if (ownerId === viewerId) continue; // already covered by the viewer's own projects above

        let projects: ProjectMeta[];
        try {
          projects = await this.listProjects(ownerId);
        } catch {
          continue;
        }

        for (const project of projects) {
          let tree: PageNode[];
          try {
            tree = await this.listPages(ownerId, project.id);
          } catch {
            continue;
          }
          const flat: PageNode[] = [];
          const walk = (nodes: PageNode[]) => {
            for (const n of nodes) {
              flat.push(n);
              walk(n.children);
            }
          };
          walk(tree);

          for (const page of flat) {
            const grant = page.sharing.find((s) => s.userId === viewerId || s.userId === '*');
            if (!grant) continue;
            if (await this.pageMatchesQuery(ownerId, project.id, page, needle)) results.push(page);
          }
        }
      }
    }

    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ---------------------------------------------------------------------
  // Public sites — moderator-curated (Admin or Team-Lead), unauthenticated-
  // readable trees drawn from across everyone's own private pages. See
  // PublicSite/PublicNode in types.ts for the full design rationale.
  // Each site is one self-contained JSON file
  // (`storageRoot/public-sites/{id}.json`, `{ site, nodes }`) — small
  // enough in practice (a curated tree, not a firehose of data) that one
  // file per site, read/written whole, is simpler than the multi-file
  // layouts used elsewhere in this engine for genuinely large or
  // frequently-partially-updated data.
  //
  // Every mutation here logs a single compact line (`[public-sites]`
  // prefix, matching the `[startup]` convention already used at server
  // boot) — kept permanently, not as temporary debugging scaffolding.
  // Cheap enough for how infrequently these operations actually happen,
  // and means a future "why didn't this show up" question can be
  // answered by reading existing logs instead of first shipping a
  // logging-only release and waiting for it to reproduce again.
  // ---------------------------------------------------------------------

  private publicSitesDir(): string {
    return joinSafe(this.root, 'public-sites');
  }

  private publicSiteFilePath(id: string): string {
    return joinSafe(this.publicSitesDir(), `${sanitizeFileName(id)}.json`);
  }

  private async readPublicSiteFile(id: string): Promise<{ site: PublicSite; nodes: PublicNode[] }> {
    return readJson<{ site: PublicSite; nodes: PublicNode[] }>(this.publicSiteFilePath(id));
  }

  async listPublicSites(): Promise<PublicSite[]> {
    const dir = this.publicSitesDir();
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return [];
      throw new FsEngineError(`Failed to list public sites: ${dir}`, 'IO_ERROR', err);
    }
    const sites = await Promise.all(
      files.filter((f) => f.endsWith('.json')).map((f) => this.readPublicSiteFile(f.slice(0, -'.json'.length)).then((r) => r.site)),
    );
    return sites.sort((a, b) => a.title.localeCompare(b.title));
  }

  async getPublicSiteById(id: string): Promise<{ site: PublicSite; nodes: PublicNode[] }> {
    return this.readPublicSiteFile(id);
  }

  /** Returns null for an unknown or disabled slug — the public route turns either into the same 404, no reason for it to distinguish "doesn't exist" from "exists but turned off" to an anonymous visitor. */
  async getPublicSiteBySlug(slug: string): Promise<{ site: PublicSite; nodes: PublicNode[] } | null> {
    const sites = await this.listPublicSites();
    const match = sites.find((s) => s.slug === slug);
    if (!match || !match.enabled) return null;
    return this.readPublicSiteFile(match.id);
  }

  async createPublicSite(input: { slug: string; title: string; description?: string }): Promise<PublicSite> {
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw new FsEngineError('Slug may only contain lowercase letters, digits, and hyphens', 'INVALID_INPUT');
    }
    if (PUBLIC_SITE_RESERVED_SLUGS.includes(slug)) {
      throw new FsEngineError(`"${slug}" is reserved and can't be used as a public site slug`, 'INVALID_INPUT');
    }
    const existing = await this.listPublicSites();
    if (existing.some((s) => s.slug === slug)) {
      throw new FsEngineError(`A public site with slug "${slug}" already exists`, 'ALREADY_EXISTS');
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const site: PublicSite = {
      id,
      slug,
      title: input.title || slug,
      description: input.description ?? '',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await fs.mkdir(this.publicSitesDir(), { recursive: true });
    await writeJsonAtomic(this.publicSiteFilePath(id), { site, nodes: [] });
    console.log(`[public-sites] created site id=${id} slug=${slug}`);
    return site;
  }

  async updatePublicSite(id: string, patch: Partial<Pick<PublicSite, 'title' | 'description' | 'enabled'>>): Promise<PublicSite> {
    const filePath = this.publicSiteFilePath(id);
    return lockManager.run(filePath, async () => {
      const current = await this.readPublicSiteFile(id);
      const updated: PublicSite = { ...current.site, ...patch, updatedAt: new Date().toISOString() };
      await writeJsonAtomic(filePath, { site: updated, nodes: current.nodes });
      console.log(`[public-sites] updated site id=${id} slug=${updated.slug} patch=${JSON.stringify(patch)}`);
      return updated;
    });
  }

  async deletePublicSite(id: string): Promise<void> {
    await fs.rm(this.publicSiteFilePath(id), { force: true });
    console.log(`[public-sites] deleted site id=${id}`);
  }

  /**
   * Submits one page for inclusion in a public site — creates a fresh
   * pending node, or (if this exact page was already submitted to this
   * same site before, in *any* status — approved, rejected, or still
   * pending) resets that existing node back to pending instead of
   * creating a duplicate. Lets a rejected submission be revised and
   * resent, or an already-approved page be resubmitted after an edit,
   * without the moderation queue accumulating stale duplicates of the
   * same page.
   */
  async submitPageToPublicSite(
    siteId: string,
    input: { ownerId: string; projectId: string; pageId: string; parentId: string | null; submittedBy: string },
  ): Promise<PublicNode> {
    const filePath = this.publicSiteFilePath(siteId);
    return lockManager.run(filePath, async () => {
      const current = await this.readPublicSiteFile(siteId);
      const now = new Date().toISOString();
      const existingIdx = current.nodes.findIndex(
        (n) => n.ownerId === input.ownerId && n.projectId === input.projectId && n.pageId === input.pageId,
      );

      let node: PublicNode;
      let nodes: PublicNode[];
      if (existingIdx >= 0) {
        const existing = current.nodes[existingIdx]!;
        node = {
          ...existing,
          parentId: input.parentId,
          status: 'pending',
          submittedBy: input.submittedBy,
          submittedAt: now,
          moderatedBy: null,
          moderatedAt: null,
          rejectionReason: null,
        };
        nodes = current.nodes.map((n, i) => (i === existingIdx ? node : n));
      } else {
        node = {
          id: randomUUID(),
          ownerId: input.ownerId,
          projectId: input.projectId,
          pageId: input.pageId,
          parentId: input.parentId,
          order: Date.now(),
          status: 'pending',
          submittedBy: input.submittedBy,
          submittedAt: now,
          moderatedBy: null,
          moderatedAt: null,
          rejectionReason: null,
        };
        nodes = [...current.nodes, node];
      }

      await writeJsonAtomic(filePath, { site: current.site, nodes });
      console.log(
        `[public-sites] submitted page site=${siteId} node=${node.id} page=${input.ownerId}/${input.projectId}/${input.pageId} by=${input.submittedBy} (${existingIdx >= 0 ? 'resubmit' : 'new'})`,
      );
      return node;
    });
  }

  // ---- Public inbox: submissions without a chosen site --------------------

  private publicInboxPath(): string {
    return joinSafe(this.root, 'public-inbox.json');
  }

  private async readPublicInbox(): Promise<PublicInboxItem[]> {
    try {
      const data = await readJson<{ items: PublicInboxItem[] }>(this.publicInboxPath());
      return Array.isArray(data.items) ? data.items : [];
    } catch (err) {
      if (err instanceof FsEngineError && err.code === 'NOT_FOUND') return [];
      throw err;
    }
  }

  async listPublicInbox(): Promise<PublicInboxItem[]> {
    const items = await this.readPublicInbox();
    return items.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  }

  /** Подаёт страницу в общую очередь без раздела. Повторная подача той же страницы обновляет существующую заявку, а не плодит дубликаты. */
  async submitPageToPublicInbox(input: { ownerId: string; projectId: string; pageId: string; submittedBy: string }): Promise<PublicInboxItem> {
    const filePath = this.publicInboxPath();
    return lockManager.run(filePath, async () => {
      const items = await this.readPublicInbox();
      const now = new Date().toISOString();
      const idx = items.findIndex((i) => i.ownerId === input.ownerId && i.projectId === input.projectId && i.pageId === input.pageId);
      let item: PublicInboxItem;
      if (idx >= 0) {
        item = { ...items[idx]!, submittedBy: input.submittedBy, submittedAt: now };
        items[idx] = item;
      } else {
        item = { id: randomUUID(), ...input, submittedAt: now };
        items.push(item);
      }
      await writeJsonAtomic(filePath, { items });
      console.log(`[public-sites] inbox submit item=${item.id} page=${input.ownerId}/${input.projectId}/${input.pageId} by=${input.submittedBy}`);
      return item;
    });
  }

  async getPublicInboxItem(itemId: string): Promise<PublicInboxItem> {
    const item = (await this.readPublicInbox()).find((i) => i.id === itemId);
    if (!item) throw new FsEngineError(`Inbox item not found: ${itemId}`, 'NOT_FOUND');
    return item;
  }

  async deletePublicInboxItem(itemId: string): Promise<void> {
    const filePath = this.publicInboxPath();
    await lockManager.run(filePath, async () => {
      const items = await this.readPublicInbox();
      await writeJsonAtomic(filePath, { items: items.filter((i) => i.id !== itemId) });
      console.log(`[public-sites] inbox removed item=${itemId}`);
    });
  }

  /**
   * Модератор распределяет заявку из очереди в раздел: страница
   * добавляется в дерево раздела сразу одобренной, заявка удаляется из
   * очереди. Работает и для выключенных разделов.
   */
  async assignPublicInboxItem(itemId: string, siteId: string, moderatedBy: string): Promise<PublicNode> {
    const item = await this.getPublicInboxItem(itemId);
    const node = await this.submitPageToPublicSite(siteId, {
      ownerId: item.ownerId,
      projectId: item.projectId,
      pageId: item.pageId,
      parentId: null,
      submittedBy: item.submittedBy,
    });
    const approved = await this.moderatePublicNode(siteId, node.id, { status: 'approved', moderatedBy });
    await this.deletePublicInboxItem(itemId);
    console.log(`[public-sites] inbox assigned item=${itemId} site=${siteId} node=${node.id} by=${moderatedBy}`);
    return approved;
  }

  /** Withdraws a submission entirely (not just rejecting it) — for either the original submitter taking it back, or a moderator removing a page from consideration/the tree altogether. Also detaches any children still pointing at this node (promotes them to top-level in the public tree) rather than leaving them referencing a parentId that no longer exists. */
  async deletePublicNode(siteId: string, nodeId: string): Promise<void> {
    const filePath = this.publicSiteFilePath(siteId);
    return lockManager.run(filePath, async () => {
      const current = await this.readPublicSiteFile(siteId);
      const nodes = current.nodes.filter((n) => n.id !== nodeId).map((n) => (n.parentId === nodeId ? { ...n, parentId: null } : n));
      await writeJsonAtomic(filePath, { site: current.site, nodes });
      console.log(`[public-sites] deleted node site=${siteId} node=${nodeId}`);
    });
  }

  async moderatePublicNode(
    siteId: string,
    nodeId: string,
    input: { status: Extract<PublicNodeStatus, 'approved' | 'rejected'>; moderatedBy: string; rejectionReason?: string | null },
  ): Promise<PublicNode> {
    const filePath = this.publicSiteFilePath(siteId);
    return lockManager.run(filePath, async () => {
      const current = await this.readPublicSiteFile(siteId);
      const idx = current.nodes.findIndex((n) => n.id === nodeId);
      if (idx === -1) throw new FsEngineError(`Public node not found: ${nodeId}`, 'NOT_FOUND');
      const target = current.nodes[idx]!;
      const updated: PublicNode = {
        ...target,
        status: input.status,
        moderatedBy: input.moderatedBy,
        moderatedAt: new Date().toISOString(),
        rejectionReason: input.status === 'rejected' ? (input.rejectionReason ?? null) : null,
      };
      const nodes = current.nodes.map((n, i) => (i === idx ? updated : n));
      await writeJsonAtomic(filePath, { site: current.site, nodes });
      console.log(`[public-sites] moderated node site=${siteId} node=${nodeId} status=${input.status} by=${input.moderatedBy}`);
      return updated;
    });
  }

  /**
   * Moderator reordering/reparenting the tree. Not restricted to
   * approved nodes only — there's no reason to force approving a
   * submission first just to stage where it'll go once approved — but a
   * pending or rejected node's position has no visible effect either
   * way, since only approved nodes render in the public tree at all.
   *
   * Guards against creating a cycle (moving a node to become a
   * descendant of itself) by walking up from the proposed new parent —
   * a small, curated tree doesn't need this often, but a cycle would
   * otherwise make the public tree's own rendering loop forever, an
   * easy mistake in a drag-and-drop-adjacent UI to want caught here
   * rather than trusted to the frontend alone.
   */
  async movePublicNode(siteId: string, nodeId: string, input: { parentId: string | null; order: number }): Promise<PublicNode> {
    const filePath = this.publicSiteFilePath(siteId);
    return lockManager.run(filePath, async () => {
      const current = await this.readPublicSiteFile(siteId);
      const idx = current.nodes.findIndex((n) => n.id === nodeId);
      if (idx === -1) throw new FsEngineError(`Public node not found: ${nodeId}`, 'NOT_FOUND');

      let cursor = input.parentId;
      while (cursor) {
        if (cursor === nodeId) {
          throw new FsEngineError('Cannot move a node to become its own descendant', 'INVALID_INPUT');
        }
        cursor = current.nodes.find((n) => n.id === cursor)?.parentId ?? null;
      }

      const updated: PublicNode = { ...current.nodes[idx]!, parentId: input.parentId, order: input.order };
      const nodes = current.nodes.map((n, i) => (i === idx ? updated : n));
      await writeJsonAtomic(filePath, { site: current.site, nodes });
      return updated;
    });
  }

  // ---------------------------------------------------------------------

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}
