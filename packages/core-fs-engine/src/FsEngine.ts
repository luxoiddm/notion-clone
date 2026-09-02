import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafeId, joinSafe, sanitizeFileName } from './pathSafety.js';
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
        loginLogoUrl: raw.loginLogoUrl ?? legacyLogoUrl,
        headerLogoUrl: raw.headerLogoUrl ?? legacyLogoUrl,
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

  private siteLogoPath(kind: 'login' | 'header'): string {
    return joinSafe(this.root, 'site', `logo-${kind}.webp`);
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
  async saveSiteLogo(kind: 'login' | 'header', data: Buffer): Promise<string> {
    const logoPath = this.siteLogoPath(kind);
    await fs.mkdir(path.dirname(logoPath), { recursive: true });
    await lockManager.run(logoPath, async () => {
      await fs.writeFile(logoPath, data);
    });
    return `/api/site-settings/logo/${kind}`;
  }

  /** Resolves the absolute path to the current logo of this kind, for the public serving route. Doesn't check the file actually exists — same as `getUserFileAbsolutePath`, the route's own `res.sendFile()` call surfaces a missing file as its own 404, nothing extra to do here. */
  getSiteLogoAbsolutePath(kind: 'login' | 'header'): string {
    return this.siteLogoPath(kind);
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
  // ---------------------------------------------------------------------

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
    return normalizeUserMeta(await readJson<Partial<UserMeta>>(joinSafe(this.root, 'users', userId, 'meta.json')));
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
    const usersDir = joinSafe(this.root, 'users');
    if (!(await this.exists(usersDir))) return [];

    const entries = await fs.readdir(usersDir, { withFileTypes: true });
    const metas: UserMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        metas.push(normalizeUserMeta(await readJson<Partial<UserMeta>>(joinSafe(usersDir, entry.name, 'meta.json'))));
      } catch {
        // Skip a folder without a valid meta.json rather than failing the whole listing.
      }
    }
    return metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateUser(userId: string, patch: Partial<Pick<UserMeta, 'displayName' | 'role' | 'enabled'>>): Promise<UserMeta> {
    assertSafeId(userId, 'userId');
    const metaPath = joinSafe(this.root, 'users', userId, 'meta.json');
    return lockManager.run(metaPath, async () => {
      const meta = normalizeUserMeta(await readJson<Partial<UserMeta>>(metaPath));
      const updated: UserMeta = { ...meta, ...patch };
      await writeJsonAtomic(metaPath, updated);
      return updated;
    });
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
    const metaPath = joinSafe(this.root, 'users', userId, 'meta.json');
    return lockManager.run(metaPath, async () => {
      const meta = normalizeUserMeta(await readJson<Partial<UserMeta>>(metaPath));
      const updated: UserMeta = { ...meta, ...patch };
      await writeJsonAtomic(metaPath, updated);
      return updated;
    });
  }

  /** Deletes a user's entire folder (all their projects/pages/history/assets) and their credentials. */
  async deleteUser(userId: string): Promise<void> {
    assertSafeId(userId, 'userId');
    const userDir = joinSafe(this.root, 'users', userId);
    await lockManager.run(userDir, async () => {
      await fs.rm(userDir, { recursive: true, force: true });
    });
    await this.removeCredentialsForUser(userId);
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
    const projectDir = joinSafe(this.root, 'users', ownerId, projectId);
    await fs.mkdir(joinSafe(projectDir, 'pages'), { recursive: true });

    const now = new Date().toISOString();
    const meta: ProjectMeta = { id: projectId, ownerId, name, icon: null, createdAt: now, updatedAt: now };
    await writeJsonAtomic(joinSafe(projectDir, 'meta.json'), meta);
    return meta;
  }

  async listProjects(ownerId: string): Promise<ProjectMeta[]> {
    assertSafeId(ownerId, 'ownerId');
    const userDir = joinSafe(this.root, 'users', ownerId);
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
    return joinSafe(this.root, 'users', assertSafeId(ownerId, 'ownerId'), assertSafeId(projectId, 'projectId'), 'pages');
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
    const usersDir = joinSafe(this.root, 'users');
    if (!(await this.exists(usersDir))) return [];

    const userEntries = (await fs.readdir(usersDir, { withFileTypes: true })).filter((e) => e.isDirectory());
    const results: PageNode[] = [];

    for (const userEntry of userEntries) {
      const ownerId = userEntry.name;
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
    return joinSafe(this.root, 'users', assertSafeId(userId, 'userId'), 'files');
  }

  private userFilesManifestPath(userId: string): string {
    return joinSafe(this.userFilesDir(userId), 'manifest.json');
  }

  private async readUserFilesManifest(
    userId: string,
  ): Promise<Record<string, { originalName: string; mimeType: string; size: number; uploadedAt: string }>> {
    try {
      return await readJson<Record<string, { originalName: string; mimeType: string; size: number; uploadedAt: string }>>(
        this.userFilesManifestPath(userId),
      );
    } catch (err) {
      if (err instanceof FsEngineError && err.code === 'NOT_FOUND') return {};
      throw err;
    }
  }

  async listUserFiles(userId: string): Promise<UserFileInfo[]> {
    const manifest = await this.readUserFilesManifest(userId);
    return Object.entries(manifest)
      .map(([fileName, info]) => ({ fileName, ...info, url: `/api/files/serve/${userId}/${fileName}` }))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  async saveUserFile(userId: string, originalFileName: string, data: Buffer, mimeType: string): Promise<UserFileInfo> {
    assertSafeId(userId, 'userId');
    const dir = this.userFilesDir(userId);
    await fs.mkdir(dir, { recursive: true });

    const safeName = sanitizeFileName(originalFileName);
    const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;
    await fs.writeFile(joinSafe(dir, fileName), data);

    const uploadedAt = new Date().toISOString();
    const manifestPath = this.userFilesManifestPath(userId);
    await lockManager.run(manifestPath, async () => {
      const manifest = await this.readUserFilesManifest(userId);
      manifest[fileName] = { originalName: safeName, mimeType, size: data.byteLength, uploadedAt };
      await writeJsonAtomic(manifestPath, manifest);
    });

    return { fileName, originalName: safeName, mimeType, size: data.byteLength, uploadedAt, url: `/api/files/serve/${userId}/${fileName}` };
  }

  async deleteUserFile(userId: string, fileName: string): Promise<void> {
    const safeName = sanitizeFileName(fileName);
    const dir = this.userFilesDir(userId);
    const manifestPath = this.userFilesManifestPath(userId);

    await lockManager.run(manifestPath, async () => {
      await fs.rm(joinSafe(dir, safeName), { force: true });
      const manifest = await this.readUserFilesManifest(userId);
      if (manifest[safeName]) {
        delete manifest[safeName];
        await writeJsonAtomic(manifestPath, manifest);
      }
    });
  }

  /** Resolves the absolute, traversal-safe path to a personal file, for the serving route. */
  getUserFileAbsolutePath(userId: string, fileName: string): string {
    const safeName = sanitizeFileName(fileName);
    return joinSafe(this.userFilesDir(userId), safeName);
  }

  // ---------------------------------------------------------------------
  // Search (naive content scan — production would delegate to Fuse/Lunr index)
  // ---------------------------------------------------------------------

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
      if (meta.title.toLowerCase().includes(needle)) {
        matches.push(meta);
        continue;
      }
      try {
        const content = await this.getPageContent(ownerId, projectId, meta.id);
        const text = content.blocks.map((b) => b.content).join(' ').toLowerCase();
        if (text.includes(needle)) matches.push(meta);
      } catch {
        // ignore unreadable content
      }
    }
    return matches;
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
