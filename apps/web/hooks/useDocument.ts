'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { randomUUID } from '../lib/uuid';
import { api, ApiError } from '../lib/api';
import type { PageBlock, PageMeta } from '../lib/types';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DELAY_MS = 3000;

export interface UseDocumentResult {
  meta: PageMeta | null;
  blocks: PageBlock[];
  isLoading: boolean;
  error: string | null;
  saveStatus: SaveStatus;
  setBlocks: (updater: PageBlock[] | ((prev: PageBlock[]) => PageBlock[])) => void;
  setTitle: (title: string) => void;
  setIcon: (icon: string | null) => Promise<void>;
  setTags: (tags: string[]) => Promise<void>;
  /** Re-fetches the current page's content/meta from the server — for when it changed server-side without the local edit flow being involved (restoring a history snapshot), where pageId itself doesn't change and so the normal load-on-pageId-change effect never fires again on its own. */
  reload: () => Promise<void>;
  /** Forces an immediate save, bypassing the debounce (e.g. on blur / navigation away). */
  flushSave: () => Promise<void>;
  uploadAsset: (file: File) => Promise<string>;
}

/**
 * Loads a single page's content + metadata and keeps it saved.
 *
 * - Edits are held in local state immediately (so typing never feels
 *   blocked on the network).
 * - Content is persisted via a 3-second debounce after the last edit, and
 *   also on unmount / page change (`flushSave`) so nothing is lost when the
 *   user navigates away right after typing.
 * - Title edits go through PATCH separately (also debounced) since it's
 *   metadata, not block content.
 */
export function useDocument(userId: string | null, projectId: string | null, pageId: string | null): UseDocumentResult {
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [blocks, setBlocksState] = useState<PageBlock[]>([]);
  const [title, setTitleState] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  const debounceHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleDebounceHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestBlocks = useRef<PageBlock[]>([]);
  const latestTitle = useRef('');
  const hasPendingChanges = useRef(false);

  // ---- Load ---------------------------------------------------------

  // Guards against a stale write if a *newer* load() call starts before
  // an older one resolves (pageId changing rapidly, or reload() firing
  // while the initial load is still in flight) — the ref-based "does my
  // call id still match the latest one" check works correctly no matter
  // which caller triggered this particular load() (see below), unlike a
  // cancelled-flag closed over by a single effect invocation, which
  // can't see calls to load() other than its own.
  const loadCallId = useRef(0);

  // Stable across renders (all its own dependencies — userId/projectId/
  // pageId — are already in its closure via the outer function's own
  // params, which don't change without a full remount) — reused both by
  // the effect below (fires on pageId change) and by the exposed
  // reload() (fires after restoring a history snapshot, where pageId
  // itself doesn't change at all, so the effect's own dependency array
  // would never re-trigger a fetch on its own).
  const load = useCallback(async () => {
    if (!userId || !projectId || !pageId) return;
    const callId = ++loadCallId.current;
    setIsLoading(true);
    setError(null);
    try {
      const { meta: loadedMeta, content } = await api.getPage(userId, projectId, pageId);
      if (loadCallId.current !== callId) return; // superseded by a newer load() call
      setMeta(loadedMeta);
      setTitleState(loadedMeta.title);
      latestTitle.current = loadedMeta.title;
      setBlocksState(content.blocks);
      latestBlocks.current = content.blocks;
      setSaveStatus('idle');
    } catch (err) {
      if (loadCallId.current !== callId) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load document');
    } finally {
      if (loadCallId.current === callId) setIsLoading(false);
    }
  }, [userId, projectId, pageId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- Save (content) -------------------------------------------------

  const persistContent = useCallback(async () => {
    if (!userId || !projectId || !pageId || !hasPendingChanges.current) return;
    setSaveStatus('saving');
    try {
      const { meta: updatedMeta } = await api.saveContent(userId, projectId, pageId, { blocks: latestBlocks.current });
      setMeta(updatedMeta);
      hasPendingChanges.current = false;
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error');
      setError(err instanceof ApiError ? err.message : 'Failed to save document');
    }
  }, [userId, projectId, pageId]);

  const scheduleSave = useCallback(() => {
    hasPendingChanges.current = true;
    if (debounceHandle.current) clearTimeout(debounceHandle.current);
    debounceHandle.current = setTimeout(() => {
      void persistContent();
    }, AUTOSAVE_DELAY_MS);
  }, [persistContent]);

  const setBlocks = useCallback(
    (updater: PageBlock[] | ((prev: PageBlock[]) => PageBlock[])) => {
      setBlocksState((prev) => {
        const next = typeof updater === 'function' ? (updater as (p: PageBlock[]) => PageBlock[])(prev) : updater;
        latestBlocks.current = next;
        return next;
      });
      scheduleSave();
    },
    [scheduleSave],
  );

  const flushSave = useCallback(async () => {
    if (debounceHandle.current) clearTimeout(debounceHandle.current);
    await persistContent();
  }, [persistContent]);

  // Flush any pending save when the page changes or the component unmounts,
  // so a quick navigation right after typing never drops the last edit.
  useEffect(() => {
    return () => {
      if (debounceHandle.current) clearTimeout(debounceHandle.current);
      void persistContent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // ---- Save (title) -----------------------------------------------------

  const persistTitle = useCallback(
    async (titleToSave: string) => {
      if (!userId || !projectId || !pageId) return;
      setSaveStatus('saving');
      try {
        const updated = await api.renamePage(userId, projectId, pageId, titleToSave);
        setMeta(updated);
        setSaveStatus('saved');
      } catch {
        setSaveStatus('error');
      }
    },
    [userId, projectId, pageId],
  );

  const setTitle = useCallback(
    (nextTitle: string) => {
      setTitleState(nextTitle);
      latestTitle.current = nextTitle;
      if (!userId || !projectId || !pageId) return;
      if (titleDebounceHandle.current) clearTimeout(titleDebounceHandle.current);
      titleDebounceHandle.current = setTimeout(() => {
        void persistTitle(nextTitle);
      }, AUTOSAVE_DELAY_MS);
    },
    [userId, projectId, pageId, persistTitle],
  );

  // Same reasoning as the content-flush effect above, for the title's own
  // separate debounce — without this, typing a new title and navigating
  // away within the debounce window silently drops the rename. This was
  // missing even though the sibling content-flush effect existed, hence
  // "renaming right before leaving the page doesn't stick" as an
  // observed bug distinct from the content-loss case that effect already
  // covered.
  useEffect(() => {
    return () => {
      if (titleDebounceHandle.current) {
        clearTimeout(titleDebounceHandle.current);
        void persistTitle(latestTitle.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // ---- Save (icon) --------------------------------------------------------
  // No debounce, unlike setTitle — a picker click is one discrete action,
  // not continuous typing that needs coalescing into fewer saves.

  const setIcon = useCallback(
    async (icon: string | null) => {
      if (!userId || !projectId || !pageId) return;
      setSaveStatus('saving');
      try {
        const updated = await api.updatePageIcon(userId, projectId, pageId, icon);
        setMeta(updated);
        setSaveStatus('saved');
      } catch {
        setSaveStatus('error');
      }
    },
    [userId, projectId, pageId],
  );

  const setTags = useCallback(
    async (tags: string[]) => {
      if (!userId || !projectId || !pageId) return;
      setSaveStatus('saving');
      try {
        const updated = await api.updatePageTags(userId, projectId, pageId, tags);
        setMeta(updated);
        setSaveStatus('saved');
      } catch {
        setSaveStatus('error');
      }
    },
    [userId, projectId, pageId],
  );

  // ---- Assets ------------------------------------------------------------

  const uploadAsset = useCallback(
    async (file: File) => {
      if (!userId || !projectId || !pageId) throw new Error('No active document');
      const asset = await api.uploadAsset(userId, projectId, pageId, file);
      return asset.relativePath;
    },
    [userId, projectId, pageId],
  );

  return {
    meta: meta ? { ...meta, title } : null,
    blocks,
    isLoading,
    error,
    saveStatus,
    setBlocks,
    setTitle,
    setIcon,
    setTags,
    reload: load,
    flushSave,
    uploadAsset,
  };
}

/** Convenience helper for callers that just need to create a page and navigate to it. */
export async function createDocument(
  userId: string,
  projectId: string,
  input: { title?: string; parentId?: string | null } = {},
): Promise<PageMeta> {
  return api.createPage(userId, projectId, { title: input.title ?? 'Untitled', parentId: input.parentId ?? null });
}

// Re-exported so callers building optimistic local blocks can mint IDs
// consistently with the server (both are plain UUID v4 strings).
export { randomUUID };
