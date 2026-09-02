'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getLastLocation, saveLastLocation } from '../../lib/lastLocation';
import { ArrowLeft, MessageSquare, Plus, Users, Loader2, Phone, Trash2 } from 'lucide-react';
import { useSession } from '../../components/SessionProvider';
import { api, chatApi, type ChatListItem, type ChatSummary } from '../../lib/api';
import { NewChatDialog } from '../../components/NewChatDialog';
import { ChatWindow } from '../../components/ChatWindow';
import { useCall } from '../../components/CallProvider';
import { CallGrid } from '../../components/CallGrid';
import { CallControls } from '../../components/CallControls';
import { MobilePrivateCallScreen } from '../../components/MobilePrivateCallScreen';
import { Avatar } from '../../components/Avatar';
import { ToastProvider } from '../../components/Toast';

function chatTitle(chat: ChatSummary, currentUserId: string, usersById: Map<string, { displayName: string; avatarUrl: string | null }>): string {
  if (chat.kind === 'group') {
    if (chat.name) return chat.name;
    const others = chat.memberIds.filter((id) => id !== currentUserId).map((id) => usersById.get(id)?.displayName ?? id);
    return others.length > 0 ? others.join(', ') : 'Группа';
  }
  const otherId = chat.memberIds.find((id) => id !== currentUserId);
  return (otherId && usersById.get(otherId)?.displayName) || 'Личный чат';
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-ink-muted">
          <Loader2 size={18} className="animate-spin" />
        </div>
      }
    >
      <ToastProvider>
        <ChatPageContent />
      </ToastProvider>
    </Suspense>
  );
}

function ChatPageContent() {
  const { user, accessToken, isLoading: sessionLoading } = useSession();
  const { activeCall, isConnecting, error: callError, startOrJoinCall, leaveCall, toggleMic, toggleCamera, toggleScreenShare } = useCall();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [chats, setChats] = useState<ChatListItem[] | null>(null);
  const [usersById, setUsersById] = useState<Map<string, { displayName: string; avatarUrl: string | null }>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([chatApi.list(), api.listUsersDirectory()])
      .then(([list, directory]) => {
        setChats(list);
        setUsersById(new Map(directory.map((u) => [u.id, { displayName: u.displayName, avatarUrl: u.avatarUrl }])));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить чаты'));
  }, []);

  const handleDeleteChat = async (chatId: string) => {
    if (!confirm('Удалить чат целиком для всех участников? Это необратимо, вся история сообщений будет потеряна.')) return;
    try {
      await chatApi.deleteChat(chatId);
      setChats((prev) => (prev ? prev.filter((c) => c.id !== chatId) : prev));
      if (selectedChatId === chatId) setSelectedChatId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить чат');
    }
  };

  // Fires when ChatWindow hears `chat:deleted` for the chat currently
  // open — happens if another member deletes it while I'm looking at it
  // (or I deleted it myself from a different tab). Stable reference
  // (useCallback) matters here specifically: ChatWindow's socket-setup
  // effect depends on this prop, and a fresh inline function every
  // render would re-trigger that effect (re-joining the room, refetching
  // history) far more often than the chat actually changes.
  const handleChatDeletedElsewhere = useCallback(() => {
    setSelectedChatId(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (user) refresh();
  }, [user, refresh]);

  // Lets the incoming-call banner (rendered on any page) deep-link
  // straight into the right conversation: /chat?open=<chatId>. Falls
  // back to the remembered last-open chat (localStorage) when there's
  // no explicit deep-link — survives a fresh login or a brand new tab,
  // unlike the URL param, which only helps for a same-tab refresh.
  // Deliberately doesn't fall back across route kinds the way page.tsx's
  // own restore effect does (redirecting to /chat if that's where the
  // remembered location points) — landing on /chat is already an
  // explicit choice the person just made by navigating here, no reason
  // to second-guess it by bouncing back to the editor.
  useEffect(() => {
    const openId = searchParams.get('open');
    if (openId) {
      setSelectedChatId(openId);
    } else {
      const last = getLastLocation();
      if (last?.route === 'chat') setSelectedChatId(last.chatId);
    }
  }, [searchParams]);

  // The other direction of the same idea — keeps the URL in sync with
  // whichever chat is open, however it got selected (sidebar click, not
  // just the ?open= deep link above), so refreshing the page lands back
  // on the same conversation instead of the empty list view. `replace`,
  // not `push`, so switching between chats doesn't spam the browser's
  // back-button history with one entry per chat.
  useEffect(() => {
    if (selectedChatId) saveLastLocation({ route: 'chat', chatId: selectedChatId });
    const params = new URLSearchParams(window.location.search);
    if (selectedChatId) params.set('open', selectedChatId);
    else params.delete('open');
    // Skip if nothing would actually change, and deliberately don't list
    // `router` as a dependency — it isn't reliably stable across renders
    // in the App Router, and including it here caused an infinite render
    // loop (each replace() looked like "router changed" to this effect,
    // firing it again indefinitely — "Maximum update depth exceeded").
    const nextSearch = `?${params.toString()}`;
    if (nextSearch !== window.location.search) {
      router.replace(nextSearch, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChatId]);

  const selectedChat = useMemo(() => chats?.find((c) => c.id === selectedChatId) ?? null, [chats, selectedChatId]);

  if (sessionLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-ink-muted">
        <p>Нужно сначала войти в рабочее пространство.</p>
        <Link href="/" className="text-accent hover:underline">
          На главную
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-surface">
      <aside
        className={`h-full w-full flex-col border-r border-line/10 bg-surface-panel md:flex md:w-72 ${selectedChat ? 'hidden md:flex' : 'flex'}`}
      >
        <div className="flex items-center justify-between border-b border-line/10 p-3">
          <Link href="/" className="flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
            <ArrowLeft size={14} />
            Назад
          </Link>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            title="Новый чат"
            className="rounded-md border border-line/10 p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {error && <p className="px-2 py-2 text-sm text-red-500">{error}</p>}
          {chats === null ? (
            <p className="px-2 py-4 text-sm text-ink-muted">Загрузка...</p>
          ) : chats.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-ink-faint">
              Пока нет ни одного чата — начните новый кнопкой выше.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {chats.map((chat) => {
                const title = chatTitle(chat, user.id, usersById);
                return (
                  <li key={chat.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => setSelectedChatId(chat.id)}
                      className={`flex w-full items-center gap-2.5 rounded-md py-2 pl-2 pr-8 text-left text-sm ${
                        selectedChatId === chat.id ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
                      }`}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line/10 bg-surface">
                        {chat.kind === 'group' ? <Users size={14} /> : <MessageSquare size={14} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{title}</span>
                        <span className="block truncate text-xs text-ink-muted">
                          {chat.lastMessage ? (chat.lastMessage.deletedAt ? 'Сообщение удалено' : chat.lastMessage.text) : 'Сообщений пока нет'}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteChat(chat.id);
                      }}
                      title="Удалить чат"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint opacity-0 hover:bg-surface-hover hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      <main className={`min-w-0 flex-1 flex-col md:flex ${selectedChat ? 'flex' : 'hidden md:flex'}`}>
        {!selectedChat ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-muted">
            <MessageSquare size={28} className="text-ink-faint" />
            <p>Выберите чат слева или начните новый</p>
          </div>
        ) : (
          <>
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line/10 px-4">
              <button
                type="button"
                onClick={() => setSelectedChatId(null)}
                title="К списку чатов"
                className="rounded-md p-1 text-ink-muted hover:bg-surface-hover hover:text-ink md:hidden"
              >
                <ArrowLeft size={16} />
              </button>
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-line/10 bg-surface-panel">
                {selectedChat.kind === 'group' ? <Users size={13} /> : <MessageSquare size={13} />}
              </span>
              <span className="font-medium text-ink">{chatTitle(selectedChat, user.id, usersById)}</span>
              {selectedChat.kind === 'group' && (
                <span className="text-xs text-ink-muted">· {selectedChat.memberIds.length} участников</span>
              )}

              <div className="flex items-center -space-x-2">
                {selectedChat.memberIds
                  .filter((id) => id !== user.id)
                  .slice(0, 5)
                  .map((id) => {
                    const info = usersById.get(id);
                    return (
                      <div key={id} title={info?.displayName ?? id} className="rounded-full ring-2 ring-surface">
                        <Avatar avatarUrl={info?.avatarUrl ?? null} displayName={info?.displayName ?? id} size="xs" />
                      </div>
                    );
                  })}
                {selectedChat.memberIds.filter((id) => id !== user.id).length > 5 && (
                  <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-surface-hover text-[10px] text-ink-muted">
                    +{selectedChat.memberIds.filter((id) => id !== user.id).length - 5}
                  </div>
                )}
              </div>

              <div className="ml-auto">
                {activeCall?.chatId === selectedChat.id ? (
                  <span className="flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-500">
                    <Phone size={12} />
                    В звонке
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startOrJoinCall(selectedChat.id)}
                    disabled={isConnecting || (!!activeCall && activeCall.chatId !== selectedChat.id)}
                    title={activeCall && activeCall.chatId !== selectedChat.id ? 'Сначала завершите текущий звонок' : undefined}
                    className="flex items-center gap-1.5 rounded-md border border-line/10 px-2.5 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-50"
                  >
                    {isConnecting ? <Loader2 size={12} className="animate-spin" /> : <Phone size={12} />}
                    Начать звонок
                  </button>
                )}
              </div>
            </header>

            {callError && (
              <div className="border-b border-line/10 bg-red-500/10 px-4 py-2 text-sm text-red-500">{callError}</div>
            )}

            {activeCall?.chatId === selectedChat.id && (
              <div className={`border-b border-line/10 bg-surface-panel/50 ${selectedChat.kind === 'private' ? 'hidden md:block' : ''}`}>
                <div className="max-h-80 overflow-y-auto p-3">
                  <CallGrid
                    tiles={[
                      {
                        userId: user.id,
                        stream: activeCall.isScreenSharing ? activeCall.screenStream : activeCall.localStream,
                        label: activeCall.isScreenSharing ? 'Вы (экран)' : 'Вы',
                        isLocal: true,
                        cameraOff: !activeCall.isScreenSharing && !activeCall.cameraEnabled,
                        micOff: !activeCall.micEnabled,
                      },
                      ...activeCall.remoteStreams.map((peer) => ({
                        userId: peer.userId,
                        stream: peer.stream,
                        label: usersById.get(peer.userId)?.displayName ?? peer.userId,
                      })),
                    ]}
                  />
                </div>
                <CallControls
                  micEnabled={activeCall.micEnabled}
                  cameraEnabled={activeCall.cameraEnabled}
                  isScreenSharing={activeCall.isScreenSharing}
                  onToggleMic={toggleMic}
                  onToggleCamera={toggleCamera}
                  onToggleScreenShare={() => void toggleScreenShare()}
                  onLeave={leaveCall}
                />
              </div>
            )}

            {activeCall?.chatId === selectedChat.id && selectedChat.kind === 'private' && (
              <MobilePrivateCallScreen
                remoteStream={activeCall.remoteStreams[0]?.stream ?? null}
                remoteLabel={chatTitle(selectedChat, user.id, usersById)}
                localStream={activeCall.isScreenSharing ? activeCall.screenStream : activeCall.localStream}
                localCameraOff={!activeCall.cameraEnabled}
                isScreenSharing={activeCall.isScreenSharing}
                micEnabled={activeCall.micEnabled}
                cameraEnabled={activeCall.cameraEnabled}
                onToggleMic={toggleMic}
                onToggleCamera={toggleCamera}
                onToggleScreenShare={() => void toggleScreenShare()}
                onLeave={leaveCall}
              />
            )}

            <ChatWindow
              chat={selectedChat}
              currentUserId={user.id}
              accessToken={accessToken}
              usersById={usersById}
              onDeleted={handleChatDeletedElsewhere}
            />
          </>
        )}
      </main>

      {dialogOpen && (
        <NewChatDialog
          currentUserId={user.id}
          onClose={() => setDialogOpen(false)}
          onCreated={(chat) => {
            setDialogOpen(false);
            refresh();
            setSelectedChatId(chat.id);
          }}
        />
      )}
    </div>
  );
}
