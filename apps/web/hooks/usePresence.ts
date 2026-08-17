'use client';

import { useEffect, useState } from 'react';
import { getSocket } from '../lib/socket';

export interface PresenceUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Joins the realtime room for a page and reports who else is currently viewing it. */
export function usePresence(accessToken: string | null, projectId: string | null, pageId: string | null) {
  const [users, setUsers] = useState<PresenceUser[]>([]);

  useEffect(() => {
    if (!accessToken || !projectId || !pageId) return;

    const s = getSocket(accessToken);
    s.emit('page:join', { projectId, pageId });

    const onPresence = (payload: { pageId: string; users: PresenceUser[] }) => {
      if (payload.pageId === pageId) setUsers(payload.users);
    };
    s.on('presence:update', onPresence);

    return () => {
      s.emit('page:leave', { projectId, pageId });
      s.off('presence:update', onPresence);
      setUsers([]);
    };
  }, [accessToken, projectId, pageId]);

  return users;
}
