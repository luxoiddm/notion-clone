export type PageBlockType =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'numberedList'
  | 'todo'
  | 'code'
  | 'callout'
  | 'table'
  | 'image'
  | 'file'
  | 'divider';

export interface PageBlock {
  id: string;
  type: PageBlockType;
  content: string;
  checked?: boolean; // for todo blocks
  language?: string; // for code blocks
  fileName?: string; // display name for 'file' (and optionally 'image') blocks
  children?: PageBlock[];
}

export interface PageMeta {
  id: string;
  projectId: string;
  ownerId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  coverImage: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  sharing: SharingEntry[];
  isArchived: boolean;
  /** Free-text labels the author assigns — no fixed vocabulary, no per-project tag registry. Shown/edited in the editor's sidebar. */
  tags: string[];
}

export type AccessLevel = 'read' | 'comment' | 'edit' | 'admin';

export interface SharingEntry {
  userId: string; // '*' means "anyone with the link"
  level: AccessLevel;
}

export interface PageNode extends PageMeta {
  children: PageNode[];
}

export interface PageContent {
  blocks: PageBlock[];
}

/**
 * A comment on a page as a whole — not tied to any specific block, and
 * deliberately flat (no reply-to-a-comment threading). Lives in the
 * same page directory as meta.json/content.json (`comments.jsonl`),
 * colocated the same way history snapshots already are — it's page
 * data, not a separate concern the way chat is.
 */
export interface Comment {
  id: string;
  authorId: string;
  text: string;
  createdAt: string;
  editedAt: string | null;
  /** emoji -> ids of users who reacted with it. An emoji key is removed entirely once its list empties out, rather than kept around as `[]`. */
  reactions: Record<string, string[]>;
}

export interface ProjectMeta {
  id: string;
  ownerId: string;
  name: string;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserMeta {
  id: string;
  displayName: string;
  role: 'Admin' | 'Team-Lead' | 'Member' | 'Guest';
  createdAt: string;
  /** Serve URL of an image already in this user's own personal file storage — same folder/manifest as any other uploaded file, not a separate avatars tree. Resized server-side on upload (see users.routes.ts). */
  avatarUrl: string | null;
  /** A preset key (e.g. "slate"), not raw RGB — the frontend owns the palette-to-CSS-variable mapping, this is just an opaque per-user preference. */
  accentColor: string | null;
  /** A disabled user can't log in — checked at both login and refresh (so an already-issued session doesn't keep working after the fact) — but keeps every existing page/file/history untouched, unlike deleting the account. Defaults to true for any account created before this field existed (see FsEngine.getUser's own fallback). */
  enabled: boolean;
}

export interface HistorySnapshot {
  timestamp: string;
  authorId: string;
  file: string; // relative filename within .history
}

export interface AssetInfo {
  fileName: string;
  relativePath: string; // path clients use to fetch the asset
  size: number;
  mimeType: string;
}

/** A file in a user's personal file storage (independent of any single page). */
export interface UserFileInfo {
  fileName: string; // unique on-disk name
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  url: string; // path clients use to fetch/display the file
}

/**
 * A single, admin-managed record — not per-user, not per-project. Lives
 * at storageRoot/site-settings.json, not under any user's own folder.
 * Read publicly (no auth) since the login screen itself needs to show
 * the site name/description/logo before anyone has signed in; written
 * only by Admins (enforced at the route level, see site.routes.ts).
 */
export interface SiteSettings {
  siteName: string;
  siteDescription: string;
  copyrightText: string;
  /** Shown on the login screen — usually larger/more detailed, since it renders at a bigger size than the header logo. */
  loginLogoUrl: string | null;
  /** Shown in the sidebar header — usually a simpler mark, since it renders small (see NEXT_PUBLIC_HEADER_LOGO_HEIGHT). Deliberately a separate image from loginLogoUrl, not the same one reused at two sizes — a detailed logo that reads fine at login-screen size often turns to mush shrunk into a 32px header row. */
  headerLogoUrl: string | null;
  updatedAt: string;
}

/**
 * An admin/team-lead-managed public "portal" — a curated tree of pages,
 * drawn from across everyone's own private workspace, published at a
 * fixed public URL (`/{slug}`) with no login required to view. Distinct
 * from the existing per-page `sharing` (SharingEntry) mechanism: that's
 * one owner sharing one page with specific people/roles inside the
 * workspace, this is many different authors' pages curated together
 * into one public-facing structure, gated by moderation rather than by
 * the original owner's own sharing choice.
 */
export interface PublicSite {
  id: string;
  /** The public URL segment (`/{slug}`) — must be unique across all public sites, and can't collide with the app's own top-level routes. See PUBLIC_SITE_RESERVED_SLUGS below for the exact current list. */
  slug: string;
  title: string;
  description: string;
  /** A disabled site 404s at its public URL — the site and its approved tree still exist and aren't lost, just not currently reachable. Doesn't affect the moderator's own management view or the moderation queue. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PublicNodeStatus = 'pending' | 'approved' | 'rejected';

/** Every existing top-level route in apps/web/app/, plus the API proxy path — a public site can't use any of these as its slug, since Next.js would never actually route a request there to the dynamic public-site page in the first place (static segments always win over a dynamic one at the same level), making the site permanently unreachable at its own supposed URL. */
export const PUBLIC_SITE_RESERVED_SLUGS = ['admin', 'chat', 'files', 'settings', 'shared', 'api', 'moderation', 'manifest.webmanifest'];

/**
 * One page's presence within one PublicSite's own tree — this tree is
 * entirely independent of the page's `parentId` in its author's private
 * workspace (a page could be a deeply-nested child there and a top-level
 * entry here, or vice versa); moderators arrange the public tree
 * separately from however each contributor organizes their own pages.
 */
export interface PublicNode {
  id: string;
  /** Identifies the underlying page uniquely across the whole system (not just within one owner's workspace) — the public site never copies page content, only ever reads it live from here. */
  ownerId: string;
  projectId: string;
  pageId: string;
  /** Another PublicNode's id within the *same* PublicSite, or null for a top-level entry in the public tree. */
  parentId: string | null;
  order: number;
  status: PublicNodeStatus;
  submittedBy: string;
  submittedAt: string;
  moderatedBy: string | null;
  moderatedAt: string | null;
  rejectionReason: string | null;
}

/** Thrown for any fs-engine failure so callers can distinguish engine errors from generic ones. */
export class FsEngineError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'FORBIDDEN_PATH'
      | 'ALREADY_EXISTS'
      | 'INVALID_INPUT'
      | 'IO_ERROR'
      | 'LOCK_TIMEOUT',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FsEngineError';
  }
}
