import type { HistorySnapshot, PageContent, PageMeta, PageNode } from './types';

class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

let accessToken: string | null = null;
let onTokenRefreshed: ((token: string) => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

/** Lets SessionProvider's own React state stay in sync no matter which mechanism actually refreshed the token underneath it — its proactive timer, or request()'s own reactive retry-on-401 below. Only one subscriber is ever needed (there's exactly one SessionProvider), so this is a single callback slot, not an event-emitter. */
export function setOnTokenRefreshed(callback: ((token: string) => void) | null) {
  onTokenRefreshed = callback;
}

let refreshPromise: Promise<string | null> | null = null;

/**
 * Exchanges the httpOnly refresh cookie for a new access token.
 * Deduplicated — concurrent callers (several requests failing with 401
 * at once, or the reactive retry below firing at the same moment as
 * SessionProvider's own proactive timer) all await the same in-flight
 * request instead of firing off several redundant ones.
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (!res.ok) return null;
        const { accessToken: token } = (await res.json()) as { accessToken: string };
        accessToken = token;
        onTokenRefreshed?.(token);
        return token;
      } catch {
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

/**
 * Appends the current access token as a `?token=` query param. Needed for
 * any URL the browser fetches on its own — `<img src>`, `<a href>` — since
 * those requests can't carry a custom Authorization header. The server's
 * requireAuth middleware accepts either form; see agent.md for the
 * tradeoff (short-lived token visible in the URL).
 */
export function withAuthToken(url: string): string {
  if (!accessToken) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(accessToken)}`;
}

async function request<T>(path: string, init?: RequestInit, isRetryAfterRefresh = false): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init?.headers,
    },
  });

  // A 401 here almost always means the access token expired mid-session
  // (it's short-lived by design, 15 minutes) — SessionProvider's own
  // proactive timer refreshes it well before that in the normal case,
  // this is the fallback for when a backgrounded tab throttled that
  // timer, or a request happened to be in flight right as it expired.
  // Excludes /auth/* — a 401 from login itself means "wrong password",
  // not "token expired", and retrying /auth/refresh with another
  // refresh() call would just recurse.
  if (res.status === 401 && !isRetryAfterRefresh && !path.startsWith('/auth/')) {
    const newToken = await refreshAccessToken();
    if (newToken) return request<T>(path, init, true);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error ?? 'Request failed', res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  // Public — no auth required, same reasoning as siteApi.get(). See
  // tileSets.routes.ts. tileIds are opaque identifiers to pass straight
  // back as the second half of the tile image URL — numeric strings for
  // a sprite-sheet set, actual filenames for a folder-of-files set; the
  // client doesn't need to know or care which kind a given set is.
  listTileSets: () => request<{ name: string; tileIds: string[] }[]>('/tile-sets'),

  listProjects: (userId: string) =>
    request<{ id: string; ownerId: string; name: string; icon: string | null; createdAt: string; updatedAt: string }[]>(
      `/storage/${userId}/projects`,
    ),

  createProject: (userId: string, name: string) =>
    request<{ id: string; ownerId: string; name: string; icon: string | null; createdAt: string; updatedAt: string }>(
      `/storage/${userId}/projects`,
      { method: 'POST', body: JSON.stringify({ name }) },
    ),

  listPages: (userId: string, projectId: string) => request<PageNode[]>(`/storage/${userId}/${projectId}/pages`),
  getPage: (userId: string, projectId: string, pageId: string) =>
    request<{ meta: PageMeta; content: PageContent }>(`/storage/${userId}/${projectId}/pages/${pageId}`),

  listHistory: (userId: string, projectId: string, pageId: string) =>
    request<HistorySnapshot[]>(`/storage/${userId}/${projectId}/pages/${pageId}/history`),

  getHistorySnapshot: (userId: string, projectId: string, pageId: string, file: string) =>
    request<PageContent>(`/storage/${userId}/${projectId}/pages/${pageId}/history/${encodeURIComponent(file)}`),

  restoreHistorySnapshot: (userId: string, projectId: string, pageId: string, file: string) =>
    request<PageContent>(`/storage/${userId}/${projectId}/pages/${pageId}/history/${encodeURIComponent(file)}/restore`, {
      method: 'POST',
    }),

  createPage: (userId: string, projectId: string, input: { title: string; parentId?: string | null }) =>
    request<PageMeta>(`/storage/${userId}/${projectId}/pages`, { method: 'POST', body: JSON.stringify(input) }),

  saveContent: (userId: string, projectId: string, pageId: string, content: PageContent) =>
    request<{ meta: PageMeta }>(`/storage/${userId}/${projectId}/pages/${pageId}/content`, {
      method: 'PUT',
      body: JSON.stringify(content),
    }),

  renamePage: (userId: string, projectId: string, pageId: string, title: string) =>
    request<PageMeta>(`/storage/${userId}/${projectId}/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  updatePageIcon: (userId: string, projectId: string, pageId: string, icon: string | null) =>
    request<PageMeta>(`/storage/${userId}/${projectId}/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ icon }),
    }),

  updatePageTags: (userId: string, projectId: string, pageId: string, tags: string[]) =>
    request<PageMeta>(`/storage/${userId}/${projectId}/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ tags }),
    }),

  movePage: (userId: string, projectId: string, pageId: string, parentId: string | null, order: number) =>
    request<PageMeta>(`/storage/${userId}/${projectId}/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId, order }),
    }),

  deletePage: (userId: string, projectId: string, pageId: string) =>
    request<void>(`/storage/${userId}/${projectId}/pages/${pageId}`, { method: 'DELETE' }),

  search: (userId: string, projectId: string, q: string) =>
    request<PageMeta[]>(`/storage/${userId}/${projectId}/search?q=${encodeURIComponent(q)}`),

  updateSharing: (userId: string, projectId: string, pageId: string, sharing: PageMeta['sharing']) =>
    request<PageMeta>(`/storage/${userId}/${projectId}/pages/${pageId}/sharing`, {
      method: 'PUT',
      body: JSON.stringify({ sharing }),
    }),

  uploadAsset: async (userId: string, projectId: string, pageId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/storage/${userId}/${projectId}/pages/${pageId}/assets`, {
      method: 'POST',
      credentials: 'include',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      body: form,
    });
    if (!res.ok) throw new ApiError('Upload failed', res.status);
    return res.json() as Promise<{ relativePath: string }>;
  },

  // Minimal user directory (id + displayName), any authenticated user.
  listUsersDirectory: () => request<{ id: string; displayName: string; avatarUrl: string | null; accentColor: string | null }[]>('/users'),

  updateOwnAccentColor: (accentColor: string | null) =>
    request<{ id: string; displayName: string; avatarUrl: string | null; accentColor: string | null }>('/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ accentColor }),
    }),

  setOwnAvatar: (sourceFileName: string) =>
    request<{ id: string; displayName: string; avatarUrl: string | null; accentColor: string | null }>('/users/me/avatar', {
      method: 'POST',
      body: JSON.stringify({ sourceFileName }),
    }),

  // Pages shared with the current user, across everyone else's workspace.
  listShared: () => request<PageNode[]>('/shared'),

  // Current caller's profile — used to restore a session after a hard
  // refresh, once a fresh access token has been obtained via /auth/refresh.
  me: () =>
    request<{ id: string; role: 'Admin' | 'Team-Lead' | 'Member' | 'Guest'; displayName: string; avatarUrl: string | null; accentColor: string | null }>(
      '/auth/me',
    ),
};

export interface AdminUser {
  id: string;
  displayName: string;
  role: 'Admin' | 'Team-Lead' | 'Member' | 'Guest';
  email: string | null;
  createdAt: string;
}

export const adminApi = {
  listUsers: () => request<AdminUser[]>('/admin/users'),

  createUser: (input: { email: string; displayName: string; role: AdminUser['role']; password?: string }) =>
    request<{ user: AdminUser; temporaryPassword: string }>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateUser: (userId: string, patch: { displayName?: string; role?: AdminUser['role'] }) =>
    request<AdminUser>(`/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteUser: (userId: string) => request<void>(`/admin/users/${userId}`, { method: 'DELETE' }),

  resetPassword: (userId: string) =>
    request<{ temporaryPassword: string }>(`/admin/users/${userId}/reset-password`, { method: 'POST' }),

  invite: (input: { email: string; role: AdminUser['role'] }) =>
    request<{ inviteToken: string; inviteUrl: string }>('/admin/invites', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};

export interface UserFileInfo {
  fileName: string;
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  url: string;
}

export const filesApi = {
  list: () => request<UserFileInfo[]>('/files'),

  upload: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/files', {
      method: 'POST',
      credentials: 'include',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      body: form,
    });
    if (!res.ok) throw new ApiError('Upload failed', res.status);
    return res.json() as Promise<UserFileInfo>;
  },

  remove: (fileName: string) => request<void>(`/files/${encodeURIComponent(fileName)}`, { method: 'DELETE' }),
};

export type ChatKind = 'private' | 'group';

export interface ChatAttachment {
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  authorId: string;
  threadRootId: string | null;
  text: string;
  pageRef: { ownerId: string; projectId: string; pageId: string } | null;
  attachment: ChatAttachment | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  reactions: Record<string, string[]>;
  /** Only ever set on objects returned by getMessages (the list fetch) — a single-message operation (send/edit/react) has no reason to recompute it, so it stays undefined there. See ChatMessageWithReplyCount in @core/chat for why this isn't stored, just computed on read. */
  replyCount?: number;
}

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  memberIds: string[];
  projectId: string | null;
  name: string | null;
  createdAt: string;
}

export interface ChatListItem extends ChatSummary {
  lastMessage: ChatMessage | null;
}

export interface Comment {
  id: string;
  authorId: string;
  text: string;
  createdAt: string;
  editedAt: string | null;
  reactions: Record<string, string[]>;
}

export const commentsApi = {
  list: (ownerId: string, projectId: string, pageId: string) =>
    request<Comment[]>(`/storage/${ownerId}/${projectId}/pages/${pageId}/comments`),

  add: (ownerId: string, projectId: string, pageId: string, text: string) =>
    request<Comment>(`/storage/${ownerId}/${projectId}/pages/${pageId}/comments`, { method: 'POST', body: JSON.stringify({ text }) }),

  edit: (ownerId: string, projectId: string, pageId: string, commentId: string, text: string) =>
    request<Comment>(`/storage/${ownerId}/${projectId}/pages/${pageId}/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    }),

  remove: (ownerId: string, projectId: string, pageId: string, commentId: string) =>
    request<void>(`/storage/${ownerId}/${projectId}/pages/${pageId}/comments/${commentId}`, { method: 'DELETE' }),

  toggleReaction: (ownerId: string, projectId: string, pageId: string, commentId: string, emoji: string) =>
    request<Comment>(`/storage/${ownerId}/${projectId}/pages/${pageId}/comments/${commentId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    }),
};

export const chatApi = {
  list: () => request<ChatListItem[]>('/chats'),

  getSummary: (chatId: string) => request<ChatSummary>(`/chats/${chatId}`),

  deleteChat: (chatId: string) => request<void>(`/chats/${chatId}`, { method: 'DELETE' }),

  getOrCreatePrivate: (otherUserId: string) =>
    request<ChatSummary>('/chats/private', { method: 'POST', body: JSON.stringify({ otherUserId }) }),

  createGroup: (input: { name?: string | null; memberIds: string[]; projectId?: string | null }) =>
    request<ChatSummary>('/chats', { method: 'POST', body: JSON.stringify({ kind: 'group', ...input }) }),

  getMessages: (chatId: string, limit?: number) =>
    request<ChatMessage[]>(`/chats/${chatId}/messages${limit ? `?limit=${limit}` : ''}`),

  sendMessage: (
    chatId: string,
    input: {
      text: string;
      threadRootId?: string | null;
      pageRef?: { ownerId: string; projectId: string; pageId: string } | null;
      attachment?: ChatAttachment | null;
    },
  ) => request<ChatMessage>(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify(input) }),

  getThreadReplies: (chatId: string, threadRootId: string) =>
    request<ChatMessage[]>(`/chats/${chatId}/threads/${threadRootId}`),

  editMessage: (chatId: string, messageId: string, text: string) =>
    request<ChatMessage>(`/chats/${chatId}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ text }) }),

  deleteMessage: (chatId: string, messageId: string) =>
    request<ChatMessage | { id: string; fullyDeleted: true }>(`/chats/${chatId}/messages/${messageId}`, { method: 'DELETE' }),

  toggleReaction: (chatId: string, messageId: string, emoji: string) =>
    request<ChatMessage>(`/chats/${chatId}/messages/${messageId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }),
};

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const webrtcApi = {
  getIceServers: () => request<{ iceServers: IceServerConfig[]; turnConfigured: boolean }>('/webrtc/ice-servers'),
};

export interface SiteSettings {
  siteName: string;
  siteDescription: string;
  copyrightText: string;
  loginLogoUrl: string | null;
  headerLogoUrl: string | null;
  updatedAt: string;
  /** Deployed app version, from apps/server/package.json — read-only, not settable via updateSettings(). */
  version: string;
}

export const siteApi = {
  // Public — no auth required (and none is sent if the caller hasn't
  // logged in yet, e.g. the login screen itself). See site.routes.ts.
  get: () => request<SiteSettings>('/site-settings'),

  updateSettings: (patch: Partial<Pick<SiteSettings, 'siteName' | 'siteDescription' | 'copyrightText'>>) =>
    request<SiteSettings>('/admin/site-settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  uploadLogo: async (kind: 'login' | 'header', file: File) => {
    const form = new FormData();
    form.append('logo', file);
    const res = await fetch(`/api/admin/site-settings/logo/${kind}`, {
      method: 'POST',
      credentials: 'include',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(body.error ?? 'Upload failed', res.status);
    }
    return res.json() as Promise<SiteSettings>;
  },
};

export { ApiError };
