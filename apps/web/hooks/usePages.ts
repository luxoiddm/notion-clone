'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PageNode } from '../lib/types';

export function usePages(userId: string | null, projectId: string | null) {
  const [pages, setPages] = useState<PageNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId || !projectId) return;
    setIsLoading(true);
    try {
      setPages(await api.listPages(userId, projectId));
    } finally {
      setIsLoading(false);
    }
  }, [userId, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Updates one node's title in the local tree, in place — for reflecting
  // an in-progress rename (the editor's title field) immediately, rather
  // than waiting for the debounced save to actually hit the server and
  // then re-fetching the entire tree just to see one changed word.
  const renameNode = useCallback((pageId: string, title: string) => {
    setPages((prev) => {
      const walk = (nodes: PageNode[]): PageNode[] =>
        nodes.map((n) => (n.id === pageId ? { ...n, title } : n.children.length > 0 ? { ...n, children: walk(n.children) } : n));
      return walk(prev);
    });
  }, []);

  return { pages, isLoading, refresh, renameNode };
}
