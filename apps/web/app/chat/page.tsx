'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getLastLocation, saveLastLocation, clearLastLocation } from '../../lib/lastLocation';
import { ArrowLeft, MessageSquare, Plus, Users, Loader2, Trash2, Video, UserPlus, SquarePen } from 'lucide-react';
import { SwipeRow } from '../../components/SwipeRow';
import { SwipeBack } from '../../components/SwipeBack';
import { getUnread, onUnreadChange } from '../../lib/unread';
import { getSocket } from '../../lib/socket';
import { SoundToggle } from '../../components/SoundToggle';
import { ChatMembersDialog, canManageChatMembers } from '../../components/ChatMembersDialog';
import { useSession } from '../../components/SessionProvider';
import { api, chatApi, withAuthToken, type ChatListItem, type ChatSummary } from '../../lib/api';
import { NewChatDialog } from '../../components/NewChatDialog';
import { ChatWindow } from '../../components/ChatWindow';
import { useCall } from '../../components/CallProvider';
import { CallGrid } from '../../components/CallGrid';
import { CallControls } from '../../components/CallControls';
import { MobilePrivateCallScreen } from '../../components/MobilePrivateCallScreen';
import { Avatar } from '../../components/Avatar';
import { ToastProvider } from '../../components/Toast';
import { AppShell, FullScreenLoader, SignInRequired } from '../../components/AppShell';
import { formatDuration } from '../../lib/mediaRecorder';

function chatTitle(chat: ChatSummary, currentUserId: string, usersById: Map<string, { displayName: string; avatarUrl: string | null }>): string {
  if (chat.kind === 'group') {
    // Имена всех участников не перечисляем — при 20 людях строка
    // становится бесконечной. Состав видно по аватаркам.
    return chat.name || 'Групповой чат';
  }
  const otherId =
    chat.memberIds.find((id) => id !== currentUserId) ?? (chat.leftMemberIds ?? []).find((id) => id !== currentUserId);
  return (otherId && usersById.get(otherId)?.displayName) || 'Личный чат';
}

/** Аватар группы: до четырёх аватарок участников «плиткой» в круге. */
function GroupAvatar({
  memberIds,
  usersById,
  size,
}: {
  memberIds: string[];
  usersById: Map<string, { displayName: string; avatarUrl: string | null }>;
  size: number;
}) {
  const shown = memberIds.slice(0, 4);
  if (shown.length === 0) {
    return (
      <span style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
        <Users size={size * 0.45} />
      </span>
    );
  }
  if (shown.length === 1) {
    const u = usersById.get(shown[0]!);
    return <Avatar avatarUrl={u?.avatarUrl ?? null} displayName={u?.displayName ?? '?'} size={size >= 36 ? 'md' : 'sm'} />;
  }
  return (
    <span
      style={{ width: size, height: size }}
      className="grid shrink-0 grid-cols-2 grid-rows-2 gap-px overflow-hidden rounded-full bg-surface-raised ring-1 ring-line/[0.08]"
      title={`${memberIds.length + 1} участников`}
    >
      {shown.map((id, i) => {
        const u = usersById.get(id);
        const name = u?.displayName ?? '?';
        // 2 участника — две половинки, 3 — первая занимает всю левую колонку.
        const tall = shown.length === 2 || (shown.length === 3 && i === 0);
        return (
          <span key={id} className={`relative overflow-hidden ${tall ? 'row-span-2' : ''}`}>
            {u?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={withAuthToken(u.avatarUrl)} alt={name} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center bg-accent-soft text-[9px] font-semibold text-accent-ink">
                {name.trim().slice(0, 1).toUpperCase()}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

function pluralMembers(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'участник';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'участника';
  return 'участников';
}

function formatChatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
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
  const [usersById, setUsersById] = useState<Map<string, { displayName: string; avatarUrl: string | null; dismissed?: boolean }>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  useEffect(() => {
    setUnread(getUnread());
    return onUnreadChange(setUnread);
  }, []);
  const [membersDialog, setMembersDialog] = useState<'list' | 'add' | null>(null);

  const refresh = useCallback(() => {
    Promise.all([chatApi.list(), api.listUsersDirectory()])
      .then(([list, directory]) => {
        setChats(list);
        setUsersById(new Map(directory.map((u) => [u.id, { displayName: u.displayName, avatarUrl: u.avatarUrl, dismissed: u.dismissed }])));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить чаты'));
  }, []);

  const handleDeleteChat = async (chatId: string) => {
    if (!confirm('Удалить чат у себя? Вы выйдете из него, и он пропадёт из вашего списка. У остальных участников чат и история останутся.')) return;
    try {
      await chatApi.deleteChat(chatId);
      setChats((prev) => (prev ? prev.filter((c) => c.id !== chatId) : prev));
      if (selectedChatId === chatId) setSelectedChatId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось выйти из чата');
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

  // Состав чатов меняется на лету: меня добавили в чат, исключили, или
  // кто-то вышел — сервер шлёт `chat:members-updated` в мою личную
  // комнату. Перечитываем список; если меня в открытом чате больше нет —
  // закрываем его.
  const selectedChatIdRef = useRef(selectedChatId);
  selectedChatIdRef.current = selectedChatId;
  useEffect(() => {
    if (!accessToken || !user) return;
    const socket = getSocket(accessToken);
    const onMembers = ({ chatId, memberIds }: { chatId: string; memberIds: string[] }) => {
      if (!memberIds.includes(user.id) && selectedChatIdRef.current === chatId) {
        setSelectedChatId(null);
        setMembersDialog(null);
      }
      refresh();
    };
    socket.on('chat:members-updated', onMembers);
    return () => {
      socket.off('chat:members-updated', onMembers);
    };
  }, [accessToken, user, refresh]);

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
  //
  // Запомненный чат подставляем только при первом открытии страницы.
  // Иначе кнопка «‹ К списку чатов» на телефоне не работала: она убирает
  // ?open= из адреса, этот эффект срабатывал снова, не находил параметра и
  // тут же открывал тот же чат из «последнего места».
  const restoredLastChat = useRef(false);
  useEffect(() => {
    const openId = searchParams.get('open');
    if (openId) {
      setSelectedChatId(openId);
    } else if (!restoredLastChat.current) {
      const last = getLastLocation();
      if (last?.route === 'chat') setSelectedChatId(last.chatId);
    }
    restoredLastChat.current = true;
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
    return <FullScreenLoader />;
  }

  if (!user) {
    return <SignInRequired />;
  }

  return (
    <AppShell
      flush
      title="Сообщения"
      hideMobileBar={!!selectedChat}
      fab={{ icon: <SquarePen size={22} />, label: 'Новый чат', onClick: () => setDialogOpen(true) }}
    >
      <aside
        className={`h-full w-full flex-col border-r border-line/[0.07] bg-surface md:flex md:w-[300px] md:shrink-0 ${selectedChat ? 'hidden md:flex' : 'flex'}`}
      >
        <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4 md:h-12 md:py-0">
          <h1 className="text-[30px] font-bold tracking-[-0.02em] text-ink md:text-sm md:font-semibold md:tracking-normal">
            <span className="md:hidden">Чаты</span>
            <span className="hidden md:inline">Сообщения</span>
          </h1>
          <div className="flex items-center gap-1">
            <SoundToggle />
            <button type="button" onClick={() => setDialogOpen(true)} title="Новый чат" className="btn-secondary btn-sm hidden h-7 md:inline-flex">
              <Plus size={14} />
              Новый
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {error && <p className="px-2 py-2 text-sm text-danger">{error}</p>}
          {chats === null ? (
            <div className="space-y-1 px-1 pt-1">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 px-2 py-2">
                  <div className="skeleton h-9 w-9 animate-shimmer rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <div className="skeleton h-3 w-1/2 animate-shimmer rounded" />
                    <div className="skeleton h-2.5 w-4/5 animate-shimmer rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : chats.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-12 text-center">
              <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-sunken text-ink-faint">
                <MessageSquare size={20} />
              </span>
              <p className="text-sm font-medium text-ink">Пока нет переписок</p>
              <p className="mt-1 text-xs text-ink-muted">Начните личный или групповой чат с коллегами.</p>
              <button type="button" onClick={() => setDialogOpen(true)} className="btn-primary btn-sm mt-4">
                <Plus size={13} /> Новый чат
              </button>
            </div>
          ) : (
            <ul className="space-y-px">
              {chats.map((chat) => {
                const title = chatTitle(chat, user.id, usersById);
                const otherId = chat.kind === 'private' ? chat.memberIds.find((id) => id !== user.id) : undefined;
                const other = otherId ? usersById.get(otherId) : undefined;
                const last = chat.lastMessage;
                const lastAuthor = last && last.authorId === user.id ? 'Вы: ' : '';
                const unreadCount = unread[chat.id] ?? 0;
                return (
                  <SwipeRow key={chat.id} onAction={() => void handleDeleteChat(chat.id)} actionLabel="Выйти">
                  <div className="group relative bg-surface">
                    <button
                      type="button"
                      onClick={() => setSelectedChatId(chat.id)}
                      className={`flex w-full items-center gap-3 rounded-lg py-2 pl-2 pr-2 text-left text-sm transition-colors max-md:min-h-[68px] max-md:text-[15px] ${
                        selectedChatId === chat.id ? 'bg-accent-soft/70' : 'hover:bg-surface-hover'
                      }`}
                    >
                      {chat.kind === 'private' ? (
                        <Avatar avatarUrl={other?.avatarUrl ?? null} displayName={title} size="md" className="max-md:h-12 max-md:w-12" />
                      ) : (
                        <GroupAvatar memberIds={chat.memberIds.filter((id) => id !== user.id)} usersById={usersById} size={36} />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate font-medium text-ink">{title}</span>
                          {last && <span className="shrink-0 text-2xs text-ink-faint group-hover:invisible">{formatChatTime(last.createdAt)}</span>}
                        </span>
                        <span className="flex items-center gap-2">
                        <span className={`block min-w-0 flex-1 truncate text-xs max-md:text-sm ${unreadCount ? 'text-ink' : 'text-ink-muted'}`}>
                          {last
                            ? last.deletedAt
                              ? 'Сообщение удалено'
                              : lastAuthor + (last.text || (last.gif ? 'GIF' : last.attachment ? (last.attachment.kind === 'voice' ? `Голосовое · ${formatDuration(last.attachment.duration ?? 0)}` : last.attachment.kind === 'round' ? `Кружок · ${formatDuration(last.attachment.duration ?? 0)}` : `📎 ${last.attachment.fileName}`) : last.pageRef ? 'Ссылка на страницу' : ''))
                            : 'Сообщений пока нет'}
                        </span>
                        {unreadCount > 0 && (
                          <span className="flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">
                            {unreadCount}
                          </span>
                        )}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteChat(chat.id);
                      }}
                      title="Удалить у себя (выйти из чата)"
                      className="btn-icon-sm absolute right-2 top-2 opacity-0 hover:text-danger group-hover:opacity-100 max-md:hidden"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  </SwipeRow>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      <main className={`min-w-0 flex-1 flex-col md:flex ${selectedChat ? 'flex' : 'hidden md:flex'}`}>
        {/* Телефон: свайп вправо по переписке — назад к списку чатов (дублирует «‹» в шапке). */}
        <SwipeBack
          enabled={!!selectedChat}
          onBack={() => {
            clearLastLocation();
            setSelectedChatId(null);
          }}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
        {!selectedChat ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
              <MessageSquare size={24} />
            </span>
            <p className="text-sm font-medium text-ink">Выберите переписку</p>
            <p className="mt-1 text-sm text-ink-muted">или начните новую — личную или групповую.</p>
            <button type="button" onClick={() => setDialogOpen(true)} className="btn-primary mt-5">
              <Plus size={15} /> Новый чат
            </button>
          </div>
        ) : (
          <>
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line/[0.07] px-3 sm:px-5">
              <button
                type="button"
                onClick={() => {
                  clearLastLocation();
                  setSelectedChatId(null);
                }}
                title="К списку чатов"
                aria-label="К списку чатов"
                className="btn-icon md:hidden"
              >
                <ArrowLeft size={17} />
              </button>
              {selectedChat.kind === 'group' ? (
                <GroupAvatar memberIds={selectedChat.memberIds.filter((id) => id !== user.id)} usersById={usersById} size={32} />
              ) : (
                <Avatar
                  avatarUrl={usersById.get(selectedChat.memberIds.find((id) => id !== user.id) ?? '')?.avatarUrl ?? null}
                  displayName={chatTitle(selectedChat, user.id, usersById)}
                  size="sm"
                />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold leading-5 text-ink">{chatTitle(selectedChat, user.id, usersById)}</p>
                <p className="truncate text-2xs text-ink-faint">
                  {selectedChat.kind === 'group'
                    ? `${selectedChat.memberIds.length} ${pluralMembers(selectedChat.memberIds.length)}`
                    : selectedChat.memberIds.length < 2
                      ? 'Собеседник покинул чат'
                      : 'Личная переписка'}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setMembersDialog('list')}
                title="Участники чата"
                className="ml-1 hidden items-center rounded-full p-0.5 transition-colors hover:bg-surface-hover sm:flex"
              >
                <span className="flex items-center -space-x-1.5">
                  {selectedChat.memberIds
                    .filter((id) => id !== user.id)
                    .slice(0, 5)
                    .map((id) => {
                      const info = usersById.get(id);
                      return (
                        <span key={id} title={info?.displayName ?? id} className="rounded-full ring-2 ring-surface">
                          <Avatar avatarUrl={info?.avatarUrl ?? null} displayName={info?.displayName ?? id} size="xs" />
                        </span>
                      );
                    })}
                  {selectedChat.memberIds.filter((id) => id !== user.id).length > 5 && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-surface-hover text-[10px] text-ink-muted">
                      +{selectedChat.memberIds.filter((id) => id !== user.id).length - 5}
                    </span>
                  )}
                </span>
              </button>

              <div className="ml-auto flex items-center gap-1.5">
                {canManageChatMembers(selectedChat, user) && (
                  <button type="button" onClick={() => setMembersDialog('add')} title="Добавить участников" className="btn-icon">
                    <UserPlus size={17} />
                  </button>
                )}
                <button type="button" onClick={() => setMembersDialog('list')} title="Участники чата" className="btn-icon">
                  <Users size={17} />
                </button>
              </div>

              <div>
                {activeCall?.chatId === selectedChat.id ? (
                  <span className="flex h-8 items-center gap-1.5 rounded-md bg-success/15 px-3 text-xs font-medium text-success">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                    В звонке
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startOrJoinCall(selectedChat.id)}
                    disabled={isConnecting || (!!activeCall && activeCall.chatId !== selectedChat.id)}
                    title={activeCall && activeCall.chatId !== selectedChat.id ? 'Сначала завершите текущий звонок' : undefined}
                    className="btn-secondary btn-sm h-8"
                  >
                    {isConnecting ? <Loader2 size={13} className="animate-spin" /> : <Video size={14} />}
                    <span className="hidden sm:inline">Звонок</span>
                  </button>
                )}
              </div>
            </header>

            {callError && (
              <div className="border-b border-line/10 bg-danger/10 px-4 py-2 text-sm text-danger">{callError}</div>
            )}

            {activeCall?.chatId === selectedChat.id && (
              <div data-no-swipe-back className={`border-b border-line/10 bg-surface-panel/50 ${selectedChat.kind === 'private' ? 'hidden md:block' : ''}`}>
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
        </SwipeBack>
      </main>

      {membersDialog && selectedChat && (
        <ChatMembersDialog
          key={`${selectedChat.id}:${membersDialog}`}
          initialMode={membersDialog}
          chat={selectedChat}
          currentUser={user}
          usersById={usersById}
          onClose={() => setMembersDialog(null)}
          onChanged={refresh}
          onLeft={() => {
            setMembersDialog(null);
            setChats((prev) => (prev ? prev.filter((c) => c.id !== selectedChat.id) : prev));
            setSelectedChatId(null);
            refresh();
          }}
        />
      )}

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
    </AppShell>
  );
}
