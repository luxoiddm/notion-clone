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
  checked?: boolean;
  language?: string;
  fileName?: string;
}

export interface PageContent {
  blocks: PageBlock[];
}

export interface HistorySnapshot {
  timestamp: string;
  /** Empty string for a snapshot whose filename didn't carry an author (shouldn't happen for anything saved by this version, but the backend parses defensively either way). */
  authorId: string;
  file: string;
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
  sharing: { userId: string; level: 'read' | 'comment' | 'edit' | 'admin' }[];
  isArchived: boolean;
  tags: string[];
}

export interface PageNode extends PageMeta {
  children: PageNode[];
}

export interface CurrentUser {
  id: string;
  displayName: string;
  role: 'Admin' | 'Team-Lead' | 'Member' | 'Guest';
  avatarUrl: string | null;
  accentColor: string | null;
}
