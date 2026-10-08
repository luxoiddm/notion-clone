'use client';

import { useEffect } from 'react';
import { getSocket } from '../lib/socket';
import { claimOnce, isChatOpenAndVisible, playSound, trackVisibility, unlockAudio } from '../lib/sounds';
import { addUnread } from '../lib/unread';

interface ChatNotify {
  chatId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  isThreadReply: boolean;
}

/**
 * Звук новых сообщений — во всём приложении, не только на странице чата.
 * Сервер шлёт 'chat:notify' в личную комнату каждого участника (кроме
 * автора). Молчим, если этот чат открыт во вкладке, которая сейчас на
 * экране, и если событие уже «озвучила» другая вкладка.
 */
export function SoundNotifier({ accessToken, currentUserId }: { accessToken: string | null; currentUserId: string | null }) {
  // Браузер разрешает звук только после первого действия пользователя.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    const untrack = trackVisibility();
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
      untrack();
    };
  }, []);

  useEffect(() => {
    if (!accessToken || !currentUserId) return;
    const socket = getSocket(accessToken);
    const onNotify = (n: ChatNotify) => {
      if (n.authorId === currentUserId) return;
      if (isChatOpenAndVisible(n.chatId)) return;
      if (!claimOnce(`msg:${n.messageId}`)) return;
      addUnread(n.chatId);
      playSound('message');
    };
    socket.on('chat:notify', onNotify);
    return () => {
      socket.off('chat:notify', onNotify);
    };
  }, [accessToken, currentUserId]);

  return null;
}
