'use client';

import { useEffect, useRef, useState } from 'react';
import { Send, Loader2, MessageCircle, ChevronDown, ChevronUp, Paperclip, Upload, X, Pencil, Trash2, SmilePlus, FileSymlink } from 'lucide-react';
import { chatApi, type ChatMessage, type ChatSummary, type ChatAttachment, type UserFileInfo } from '../lib/api';
import { chatMarkdownToHtml, htmlToMarkdown } from '../lib/pasteToBlocks';
import { getSocket } from '../lib/socket';
import { PagePickerDialog, type AttachedPageRef } from './PagePickerDialog';
import { PageRefCard } from './PageRefCard';
import { FilePickerDialog } from './FilePickerDialog';
import { ChatAttachmentView } from './ChatAttachmentView';
import { Avatar } from './Avatar';
import { useToast } from './Toast';

const TYPING_DEBOUNCE_MS = 2000;
const TYPING_STALE_MS = 3000;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// A small fixed set rather than a full emoji picker — keeps this
// dependency-free and covers what most reactions in a work chat actually
// are. Clicking a reaction already showing yours removes it (toggle).
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '👀'];

/**
 * Combines the "attach page" and "attach file" buttons behind one icon
 * with a dropdown — two separate always-visible icon buttons ate too
 * much of the composer's width on mobile. Same click-outside-closes
 * pattern as DownloadMenu in DocumentSidebar.tsx (one convention for
 * every small dropdown in this app, not a bespoke one per component) —
 * opens upward (`bottom-full`), unlike DownloadMenu's downward
 * `top-full`, since this sits at the bottom of the chat window, not
 * near the top of a sidebar panel.
 */
function AttachMenu({ onAttachPage, onAttachFile }: { onAttachPage: () => void; onAttachFile: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Прикрепить"
        className="rounded-md border border-line/10 px-2.5 py-2 text-ink-muted hover:bg-surface-hover hover:text-ink"
      >
        <Paperclip size={14} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-44 rounded-lg border border-line/10 bg-surface-panel p-1 shadow-panel">
          <button
            type="button"
            onClick={() => {
              onAttachPage();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <FileSymlink size={13} />
            Страницу
          </button>
          <button
            type="button"
            onClick={() => {
              onAttachFile();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <Upload size={13} />
            Файл
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Converts a rich-text paste (real HTML formatting from the clipboard —
 * a webpage, Word, another chat) to Markdown source and inserts it at the
 * cursor, instead of letting the browser flatten it to plain text. Plain
 * text/Markdown-source pastes (no `text/html` payload, or nothing worth
 * converting) fall through to the native paste — they're already exactly
 * what we want, since a chat message's stored text *is* Markdown source.
 * Returns whether it handled the paste, so the caller knows whether it
 * needs to call `preventDefault` itself.
 */
function insertMarkdownFromPaste(e: React.ClipboardEvent<HTMLTextAreaElement>, currentValue: string, setValue: (next: string) => void): boolean {
  const html = e.clipboardData.getData('text/html');
  if (!html) return false;

  const markdown = htmlToMarkdown(html);
  if (!markdown.trim()) return false;

  e.preventDefault();
  const textarea = e.currentTarget;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  setValue(currentValue.slice(0, start) + markdown + currentValue.slice(end));

  const cursor = start + markdown.length;
  requestAnimationFrame(() => {
    textarea.selectionStart = textarea.selectionEnd = cursor;
  });
  return true;
}

function pluralizeReplies(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'ответ';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'ответа';
  return 'ответов';
}

export function ChatWindow({
  chat,
  currentUserId,
  accessToken,
  usersById,
  onDeleted,
}: {
  chat: ChatSummary;
  currentUserId: string;
  accessToken: string | null;
  usersById: Map<string, { displayName: string; avatarUrl: string | null }>;
  /** Called when this chat is deleted (by anyone — including the current user from elsewhere, or another member) while it's open. */
  onDeleted: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { push } = useToast();
  const [composerText, setComposerText] = useState('');
  const [attachedPage, setAttachedPage] = useState<AttachedPageRef | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachedFile, setAttachedFile] = useState<ChatAttachment | null>(null);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [typingUserIds, setTypingUserIds] = useState<Set<string>>(new Set());
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [threadReplies, setThreadReplies] = useState<ChatMessage[]>([]);
  const [replyCounts, setReplyCounts] = useState<Map<string, number>>(new Map());
  const [threadComposerText, setThreadComposerText] = useState('');

  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const threadComposerRef = useRef<HTMLTextAreaElement>(null);
  const typingSendTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingReceiveTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const openThreadIdRef = useRef<string | null>(null);
  openThreadIdRef.current = openThreadId;

  const appendMessage = (msg: ChatMessage) => {
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  };

  const appendThreadReply = (msg: ChatMessage) => {
    setThreadReplies((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  };

  // Replaces a message by id wherever it currently appears — the main
  // list and/or the open thread's replies. Unlike append, this must
  // update both, since we don't know locally whether the edited/deleted
  // message was a top-level message or a thread reply without checking.
  const updateMessage = (msg: ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    setThreadReplies((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
  };

  // For a fully-removed message (see ChatEngine.deleteMessage) — filters
  // it out entirely, unlike updateMessage's replace-in-place, since
  // there's no "deleted" placeholder to show for these.
  const removeMessage = (messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    setThreadReplies((prev) => prev.filter((m) => m.id !== messageId));
  };

  // Load history + join the realtime room whenever the selected chat changes.
  useEffect(() => {
    setIsLoading(true);
    setMessages([]);
    setOpenThreadId(null);
    setThreadReplies([]);
    setReplyCounts(new Map());
    // Nothing below here should ever end up sent to the *new* chat by
    // accident — a draft, an attached page/file, or an in-progress edit
    // meant for the chat just left behind.
    setComposerText('');
    setAttachedPage(null);
    setAttachedFile(null);
    setEditingMessageId(null);

    chatApi
      .getMessages(chat.id, 100)
      .then((history) => {
        // Merge rather than replace: a live message can arrive over the
        // socket (already joined below) before this REST call resolves —
        // a plain setMessages(history) would silently drop it, since
        // `history` was queried before that message existed.
        setMessages((prev) => {
          const byId = new Map(history.map((m) => [m.id, m]));
          for (const m of prev) if (!byId.has(m.id)) byId.set(m.id, m);
          return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        });
        // Same merge reasoning as above — a chat:thread-count-updated
        // could arrive over the socket in that same tiny window before
        // this resolves, and a plain replace would clobber it back to
        // the stale pre-reply count.
        setReplyCounts((prev) => {
          const next = new Map(prev);
          for (const m of history) if (m.replyCount !== undefined) next.set(m.id, m.replyCount);
          return next;
        });
      })
      .finally(() => setIsLoading(false));

    if (!accessToken) return;
    const socket = getSocket(accessToken);
    socket.emit('chat:join', { chatId: chat.id });

    const onMessage = (msg: ChatMessage) => {
      if (msg.chatId !== chat.id) return;
      if (msg.threadRootId === null) {
        appendMessage(msg);
      } else if (msg.threadRootId === openThreadIdRef.current) {
        appendThreadReply(msg);
      }
    };

    const onMessageUpdated = (msg: ChatMessage) => {
      if (msg.chatId !== chat.id) return;
      updateMessage(msg);
    };

    const onMessageDeleted = ({ chatId: cid, messageId }: { chatId: string; messageId: string }) => {
      if (cid !== chat.id) return;
      removeMessage(messageId);
    };

    const onChatDeleted = ({ chatId: cid }: { chatId: string }) => {
      if (cid !== chat.id) return;
      onDeleted();
    };

    const onThreadCountUpdated = ({ chatId: cid, threadRootId, replyCount }: { chatId: string; threadRootId: string; replyCount: number }) => {
      if (cid !== chat.id) return;
      setReplyCounts((prev) => new Map(prev).set(threadRootId, replyCount));
    };

    const onTyping = ({ chatId: cid, userId, isTyping }: { chatId: string; userId: string; isTyping: boolean }) => {
      if (cid !== chat.id || userId === currentUserId) return;
      const timeouts = typingReceiveTimeouts.current;
      const existing = timeouts.get(userId);
      if (existing) clearTimeout(existing);

      if (isTyping) {
        setTypingUserIds((prev) => new Set(prev).add(userId));
        timeouts.set(
          userId,
          setTimeout(() => {
            setTypingUserIds((prev) => {
              const next = new Set(prev);
              next.delete(userId);
              return next;
            });
          }, TYPING_STALE_MS),
        );
      } else {
        setTypingUserIds((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
    };

    socket.on('chat:message', onMessage);
    socket.on('chat:message-updated', onMessageUpdated);
    socket.on('chat:message-deleted', onMessageDeleted);
    socket.on('chat:deleted', onChatDeleted);
    socket.on('chat:thread-count-updated', onThreadCountUpdated);
    socket.on('chat:typing', onTyping);

    return () => {
      socket.emit('chat:leave', { chatId: chat.id });
      socket.off('chat:message', onMessage);
      socket.off('chat:message-updated', onMessageUpdated);
      socket.off('chat:message-deleted', onMessageDeleted);
      socket.off('chat:deleted', onChatDeleted);
      socket.off('chat:thread-count-updated', onThreadCountUpdated);
      socket.off('chat:typing', onTyping);
      for (const t of typingReceiveTimeouts.current.values()) clearTimeout(t);
      typingReceiveTimeouts.current.clear();
      setTypingUserIds(new Set());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, accessToken, onDeleted]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  // Grows the composer with its content (up to the max-h-40 cap in the
  // className below, which switches to internal scrolling past that).
  // Keyed on composerText, not just the onChange handler, so it also
  // resets back to one line when the text is cleared programmatically
  // after sending — onChange never fires for that, since it's not a user
  // input event.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [composerText]);

  useEffect(() => {
    const el = threadComposerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [threadComposerText]);

  const emitTyping = (isTyping: boolean) => {
    if (!accessToken) return;
    getSocket(accessToken).emit('chat:typing', { chatId: chat.id, isTyping });
  };

  const handleComposerChange = (text: string) => {
    setComposerText(text);
    emitTyping(true);
    if (typingSendTimeout.current) clearTimeout(typingSendTimeout.current);
    typingSendTimeout.current = setTimeout(() => emitTyping(false), TYPING_DEBOUNCE_MS);
  };

  const handleSend = async () => {
    const text = composerText.trim();
    if (!text && !attachedPage && !attachedFile) return;

    const pageRef = attachedPage ? { ownerId: attachedPage.ownerId, projectId: attachedPage.projectId, pageId: attachedPage.pageId } : null;
    const attachment = attachedFile;

    setComposerText('');
    setAttachedPage(null);
    setAttachedFile(null);
    if (typingSendTimeout.current) clearTimeout(typingSendTimeout.current);
    emitTyping(false);

    try {
      const message = await chatApi.sendMessage(chat.id, { text, pageRef, attachment });
      appendMessage(message);
    } catch (err) {
      // Restore what the person was trying to send — e.g. an attachment
      // rejected by CHAT_ALLOWED_MIME_TYPES — instead of silently
      // vanishing the message they just composed with no way to retry it.
      setComposerText(text);
      setAttachedPage(attachedPage);
      setAttachedFile(attachment);
      push(err instanceof Error ? err.message : 'Не удалось отправить сообщение', 'error');
    }
  };

  const openThread = async (rootId: string) => {
    setOpenThreadId(rootId);
    openThreadIdRef.current = rootId;
    setThreadReplies(await chatApi.getThreadReplies(chat.id, rootId));
  };

  const closeThread = () => {
    setOpenThreadId(null);
    openThreadIdRef.current = null;
    setThreadReplies([]);
  };

  const handleSendThreadReply = async () => {
    const text = threadComposerText.trim();
    if (!text || !openThreadId) return;
    setThreadComposerText('');
    try {
      const message = await chatApi.sendMessage(chat.id, { text, threadRootId: openThreadId });
      appendThreadReply(message);
    } catch (err) {
      setThreadComposerText(text);
      push(err instanceof Error ? err.message : 'Не удалось отправить сообщение', 'error');
    }
  };

  // Own-message editing. The saved edit also arrives back over
  // `chat:message-updated` (see the listener above), but updating local
  // state here directly means the editor closes immediately instead of
  // waiting on a socket round-trip — the incoming event then just no-ops
  // against state that already matches.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const handleSaveEdit = async (messageId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setEditingMessageId(null);
    const updated = await chatApi.editMessage(chat.id, messageId, trimmed);
    updateMessage(updated);
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!confirm('Удалить сообщение? Это необратимо.')) return;
    const result = await chatApi.deleteMessage(chat.id, messageId);
    if ('fullyDeleted' in result) {
      removeMessage(messageId);
    } else {
      updateMessage(result);
    }
  };

  const handleToggleReaction = async (messageId: string, emoji: string) => {
    const updated = await chatApi.toggleReaction(chat.id, messageId, emoji);
    updateMessage(updated);
  };

  const typingNames = [...typingUserIds].map((id) => usersById.get(id)?.displayName ?? id);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-ink-muted">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-faint">Сообщений пока нет — напишите первое.</p>
        ) : (
          messages.map((msg) => (
            <MessageRow
              key={msg.id}
              message={msg}
              isMine={msg.authorId === currentUserId}
              authorName={usersById.get(msg.authorId)?.displayName ?? msg.authorId}
              authorAvatarUrl={usersById.get(msg.authorId)?.avatarUrl ?? null}
              replyCount={replyCounts.get(msg.id) ?? 0}
              isThreadOpen={openThreadId === msg.id}
              onToggleThread={() => (openThreadId === msg.id ? closeThread() : openThread(msg.id))}
              isEditing={editingMessageId === msg.id}
              onStartEdit={() => setEditingMessageId(msg.id)}
              onCancelEdit={() => setEditingMessageId(null)}
              onSaveEdit={(text) => void handleSaveEdit(msg.id, text)}
              onDelete={() => void handleDeleteMessage(msg.id)}
              currentUserId={currentUserId}
              onToggleReaction={(emoji) => void handleToggleReaction(msg.id, emoji)}
            />
          ))
        )}
      </div>

      {openThreadId && (
        <div className="max-h-64 shrink-0 overflow-y-auto border-t border-line/10 bg-surface-panel px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase text-ink-faint">
            <span>Тред</span>
            <button type="button" onClick={closeThread} className="text-ink-muted hover:text-ink">
              Закрыть
            </button>
          </div>
          <div className="space-y-2">
            {threadReplies.length === 0 ? (
              <p className="text-sm text-ink-faint">Пока нет ответов.</p>
            ) : (
              threadReplies.map((reply) => (
                <MessageRow
                  key={reply.id}
                  message={reply}
                  isMine={reply.authorId === currentUserId}
                  authorName={usersById.get(reply.authorId)?.displayName ?? reply.authorId}
                  authorAvatarUrl={usersById.get(reply.authorId)?.avatarUrl ?? null}
                  replyCount={0}
                  isThreadOpen={false}
                  onToggleThread={() => undefined}
                  isEditing={editingMessageId === reply.id}
                  onStartEdit={() => setEditingMessageId(reply.id)}
                  onCancelEdit={() => setEditingMessageId(null)}
                  onSaveEdit={(text) => void handleSaveEdit(reply.id, text)}
                  onDelete={() => void handleDeleteMessage(reply.id)}
                  currentUserId={currentUserId}
                  onToggleReaction={(emoji) => void handleToggleReaction(reply.id, emoji)}
                  compact
                />
              ))
            )}
          </div>
          <div className="mt-2 flex items-end gap-2">
            <textarea
              ref={threadComposerRef}
              value={threadComposerText}
              onChange={(e) => setThreadComposerText(e.target.value)}
              onPaste={(e) => insertMarkdownFromPaste(e, threadComposerText, setThreadComposerText)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void handleSendThreadReply();
                }
              }}
              placeholder="Ответить в теме... (Ctrl+Enter — отправить)"
              rows={1}
              className="max-h-32 flex-1 resize-none overflow-y-auto rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void handleSendThreadReply()}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-white hover:opacity-90"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-line/10 px-4 py-3">
        {typingNames.length > 0 && (
          <p className="mb-1.5 flex items-center gap-1.5 text-xs text-ink-muted">
            <MessageCircle size={12} className="animate-pulse" />
            {typingNames.join(', ')} печатает...
          </p>
        )}
        {attachedPage && (
          <div className="mb-2 flex w-fit items-center gap-2 rounded-md border border-line/10 bg-surface-panel px-2.5 py-1.5 text-xs">
            <span className="text-ink">{attachedPage.title}</span>
            <button type="button" onClick={() => setAttachedPage(null)} className="text-ink-faint hover:text-ink">
              <X size={12} />
            </button>
          </div>
        )}
        {attachedFile && (
          <div className="mb-2 flex w-fit items-center gap-2 rounded-md border border-line/10 bg-surface-panel px-2.5 py-1.5 text-xs">
            <span className="text-ink">{attachedFile.fileName}</span>
            <button type="button" onClick={() => setAttachedFile(null)} className="text-ink-faint hover:text-ink">
              <X size={12} />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <AttachMenu onAttachPage={() => setPickerOpen(true)} onAttachFile={() => setFilePickerOpen(true)} />
          <textarea
            ref={composerRef}
            value={composerText}
            onChange={(e) => handleComposerChange(e.target.value)}
            onPaste={(e) => insertMarkdownFromPaste(e, composerText, handleComposerChange)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Написать сообщение... (Ctrl+Enter — отправить, поддерживается Markdown)"
            rows={1}
            className="max-h-40 flex-1 resize-none overflow-y-auto rounded-md border border-line/10 bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!composerText.trim() && !attachedPage && !attachedFile}
            className="shrink-0 rounded-md bg-accent px-3 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            <Send size={14} />
          </button>
        </div>
      </div>

      {pickerOpen && (
        <PagePickerDialog
          currentUserId={currentUserId}
          onClose={() => setPickerOpen(false)}
          onPick={(page) => {
            setAttachedPage(page);
            setPickerOpen(false);
          }}
        />
      )}

      {filePickerOpen && (
        <FilePickerDialog
          onClose={() => setFilePickerOpen(false)}
          onPick={(file: UserFileInfo) => {
            setAttachedFile({ url: file.url, fileName: file.originalName, mimeType: file.mimeType, size: file.size });
            setFilePickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

function MessageRow({
  message,
  isMine,
  authorName,
  authorAvatarUrl,
  replyCount,
  isThreadOpen,
  onToggleThread,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  currentUserId,
  onToggleReaction,
  compact = false,
}: {
  message: ChatMessage;
  isMine: boolean;
  authorName: string;
  authorAvatarUrl: string | null;
  replyCount: number;
  isThreadOpen: boolean;
  onToggleThread: () => void;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (text: string) => void;
  onDelete: () => void;
  currentUserId: string;
  onToggleReaction: (emoji: string) => void;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState(message.text);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed the draft from the current text every time editing starts —
  // otherwise a second edit after cancelling the first would reopen with
  // whatever was left over in local state from before.
  useEffect(() => {
    if (isEditing) setDraft(message.text);
  }, [isEditing, message.text]);

  // Grows the edit box to fit the message being edited — a fixed 2-row
  // box (the old behavior) made editing anything longer than a couple
  // lines cramped and hard to see while typing.
  useEffect(() => {
    const el = editTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [isEditing, draft]);

  const isDeleted = !!message.deletedAt;

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [pickerOpen]);

  return (
    <div className={`flex items-start gap-2 ${isMine ? 'justify-end' : 'justify-start'}`}>
      {!isMine && !compact && <Avatar avatarUrl={authorAvatarUrl} displayName={authorName} size="sm" />}
      <div className={`group flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
        <div className={`relative max-w-[75%] rounded-lg px-3 py-2 text-sm ${isMine ? 'bg-accent text-white' : 'bg-surface-panel text-ink'}`}>
          {!isMine && !compact && <div className="mb-0.5 text-xs font-medium opacity-70">{authorName}</div>}

          {isDeleted ? (
            <div className="italic opacity-60">Сообщение удалено</div>
          ) : isEditing ? (
            <div className="flex flex-col gap-1.5">
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <textarea
                ref={editTextareaRef}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    onSaveEdit(draft);
                  } else if (e.key === 'Escape') {
                    onCancelEdit();
                  }
                }}
                rows={1}
                className={`max-h-64 resize-none overflow-y-auto rounded border px-2 py-1 text-sm focus:outline-none ${
                  isMine ? 'border-white/30 bg-white/10 text-white' : 'border-line/10 bg-surface text-ink'
                }`}
              />
            <div className="flex items-center gap-2 text-xs">
              <button type="button" onClick={() => onSaveEdit(draft)} className="underline opacity-90 hover:opacity-100">
                Сохранить
              </button>
              <span className="opacity-50">Ctrl+Enter</span>
              <button type="button" onClick={onCancelEdit} className="underline opacity-70 hover:opacity-100">
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <>
            {message.text && (
              <div
                className="chat-message-body whitespace-pre-wrap break-words"
                dangerouslySetInnerHTML={{ __html: chatMarkdownToHtml(message.text) }}
              />
            )}
            {message.pageRef && <PageRefCard ownerId={message.pageRef.ownerId} projectId={message.pageRef.projectId} pageId={message.pageRef.pageId} />}
            {message.attachment && <ChatAttachmentView attachment={message.attachment} />}
          </>
        )}

        {!isDeleted && !isEditing && (
          <div className="absolute -top-2.5 right-1 hidden items-center gap-0.5 rounded-md border border-line/10 bg-surface-panel p-0.5 text-ink-muted shadow-panel group-hover:flex">
            <div ref={pickerRef} className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                title="Добавить реакцию"
                className="rounded p-1 hover:bg-surface-hover hover:text-ink"
              >
                <SmilePlus size={11} />
              </button>
              {pickerOpen && (
                <div
                  className={`absolute bottom-full z-20 mb-1 flex gap-0.5 rounded-lg border border-line/10 bg-surface-panel p-1 shadow-panel ${
                    isMine ? 'right-0' : 'left-0'
                  }`}
                >
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        onToggleReaction(emoji);
                        setPickerOpen(false);
                      }}
                      className="rounded p-1 text-base hover:bg-surface-hover"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {isMine && (
              <>
                <button type="button" onClick={onStartEdit} title="Редактировать" className="rounded p-1 hover:bg-surface-hover hover:text-ink">
                  <Pencil size={11} />
                </button>
                <button type="button" onClick={onDelete} title="Удалить" className="rounded p-1 hover:bg-surface-hover hover:text-red-500">
                  <Trash2 size={11} />
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {!isDeleted && Object.keys(message.reactions ?? {}).length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {Object.entries(message.reactions ?? {}).map(([emoji, userIds]) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onToggleReaction(emoji)}
              className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs ${
                userIds.includes(currentUserId)
                  ? 'border-accent/40 bg-accent-soft text-ink'
                  : 'border-line/10 bg-surface text-ink-muted hover:bg-surface-hover'
              }`}
            >
              <span>{emoji}</span>
              <span>{userIds.length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-faint">
        <span>{formatTime(message.createdAt)}</span>
        {message.editedAt && !isDeleted && (
          <span title={`Изменено ${formatTime(message.editedAt)}`}>(изменено)</span>
        )}
        {!compact && replyCount === 0 && !isDeleted && (
          <button type="button" onClick={onToggleThread} className="flex items-center gap-0.5 hover:text-ink-muted">
            Ответить в теме
            {isThreadOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        )}
      </div>

      {!compact && replyCount > 0 && (
        <button
          type="button"
          onClick={onToggleThread}
          className={`mt-1 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
            isThreadOpen
              ? 'border-accent/40 bg-accent-soft text-ink'
              : 'border-line/10 bg-surface text-ink-muted hover:border-accent/30 hover:bg-accent-soft/60 hover:text-ink'
          }`}
        >
          <MessageCircle size={12} />
          <span className="font-medium">{replyCount}</span>
          <span>{pluralizeReplies(replyCount)}</span>
          {isThreadOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      )}
    </div>
    </div>
  );
}
