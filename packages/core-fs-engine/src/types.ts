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
