'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Loader2, Pencil, Trash2, SmilePlus } from 'lucide-react';
import { commentsApi, type Comment } from '../lib/api';
import { chatMarkdownToHtml, htmlToMarkdown } from '../lib/pasteToBlocks';
import { Avatar } from './Avatar';
import { useToast } from './Toast';

// Same fixed set as chat's reaction picker — one visual language for
// "react to a message" across the whole app, not two different pickers.
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '👀'];

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
}

/** Same insert-at-cursor rich-paste handler as the chat composer — a plain textarea can't hold real formatting, so pasted HTML gets converted to Markdown source instead of flattening to plain text. */
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

function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

export function CommentsPanel({
  ownerId,
  projectId,
  pageId,
  currentUserId,
  usersById,
}: {
  ownerId: string;
  projectId: string;
  pageId: string;
  currentUserId: string;
  usersById: Map<string, { displayName: string; avatarUrl: string | null }>;
}) {
  const { push } = useToast();
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [text, setText] = useState('');
  const composerRef = useAutoGrow(text);

  useEffect(() => {
    setIsLoading(true);
    setText('');
    commentsApi
      .list(ownerId, projectId, pageId)
      .then(setComments)
      .catch((err) => push(err instanceof Error ? err.message : 'Не удалось загрузить комментарии', 'error'))
      .finally(() => setIsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, projectId, pageId]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    try {
      const comment = await commentsApi.add(ownerId, projectId, pageId, trimmed);
      setComments((prev) => [...prev, comment]);
    } catch (err) {
      setText(trimmed);
      push(err instanceof Error ? err.message : 'Не удалось отправить комментарий', 'error');
    }
  };

  const handleSaveEdit = async (commentId: string, newText: string) => {
    const trimmed = newText.trim();
    if (!trimmed) return;
    try {
      const updated = await commentsApi.edit(ownerId, projectId, pageId, commentId, trimmed);
      setComments((prev) => prev.map((c) => (c.id === commentId ? updated : c)));
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось сохранить изменения', 'error');
    }
  };

  const handleDelete = async (commentId: string) => {
    if (!confirm('Удалить комментарий? Это необратимо.')) return;
    try {
      await commentsApi.remove(ownerId, projectId, pageId, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось удалить комментарий', 'error');
    }
  };

  const handleToggleReaction = async (commentId: string, emoji: string) => {
    try {
      const updated = await commentsApi.toggleReaction(ownerId, projectId, pageId, commentId, emoji);
      setComments((prev) => prev.map((c) => (c.id === commentId ? updated : c)));
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось поставить реакцию', 'error');
    }
  };

  return (
    <div className="mx-auto max-w-3xl border-t border-line/10 px-8 py-8">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink">
        <MessageCircle size={15} />
        Комментарии{comments.length > 0 ? ` (${comments.length})` : ''}
      </h2>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-ink-faint">
          <Loader2 size={14} className="animate-spin" />
          Загрузка...
        </div>
      ) : (
        <div className="space-y-4">
          {comments.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              isMine={comment.authorId === currentUserId}
              authorName={usersById.get(comment.authorId)?.displayName ?? comment.authorId}
              authorAvatarUrl={usersById.get(comment.authorId)?.avatarUrl ?? null}
              currentUserId={currentUserId}
              onSaveEdit={(t) => void handleSaveEdit(comment.id, t)}
              onDelete={() => void handleDelete(comment.id)}
              onToggleReaction={(emoji) => void handleToggleReaction(comment.id, emoji)}
            />
          ))}
          {comments.length === 0 && <p className="text-sm text-ink-faint">Пока нет комментариев — будьте первым.</p>}
        </div>
      )}

      <div className="mt-5 flex items-start gap-2">
        <Avatar avatarUrl={usersById.get(currentUserId)?.avatarUrl ?? null} displayName={usersById.get(currentUserId)?.displayName ?? '?'} size="sm" />
        <div className="flex-1">
          <textarea
            ref={composerRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => insertMarkdownFromPaste(e, text, setText)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Написать комментарий... (Ctrl+Enter — отправить, поддерживается Markdown)"
            rows={1}
            className="max-h-40 w-full resize-none overflow-y-auto rounded-md border border-line/10 bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!text.trim()}
            className="mt-2 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Комментировать
          </button>
        </div>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  isMine,
  authorName,
  authorAvatarUrl,
  currentUserId,
  onSaveEdit,
  onDelete,
  onToggleReaction,
}: {
  comment: Comment;
  isMine: boolean;
  authorName: string;
  authorAvatarUrl: string | null;
  currentUserId: string;
  onSaveEdit: (text: string) => void;
  onDelete: () => void;
  onToggleReaction: (emoji: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);
  const editRef = useAutoGrow(draft);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isEditing) setDraft(comment.text);
  }, [isEditing, comment.text]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [pickerOpen]);

  return (
    <div className="group flex items-start gap-2.5">
      <Avatar avatarUrl={authorAvatarUrl} displayName={authorName} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-ink">{authorName}</span>
          <span className="text-xs text-ink-faint">{formatTime(comment.createdAt)}</span>
          {comment.editedAt && <span className="text-xs text-ink-faint">(изменено)</span>}
        </div>

        {isEditing ? (
          <div className="mt-1 flex flex-col gap-1.5">
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <textarea
              ref={editRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  onSaveEdit(draft);
                  setIsEditing(false);
                } else if (e.key === 'Escape') {
                  setIsEditing(false);
                }
              }}
              rows={1}
              className="max-h-64 w-full resize-none overflow-y-auto rounded border border-line/10 bg-surface px-2 py-1 text-sm focus:outline-none"
            />
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => {
                  onSaveEdit(draft);
                  setIsEditing(false);
                }}
                className="text-accent underline hover:opacity-80"
              >
                Сохранить
              </button>
              <span className="text-ink-faint opacity-50">Ctrl+Enter</span>
              <button type="button" onClick={() => setIsEditing(false)} className="text-ink-faint underline hover:opacity-80">
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <div
            className="chat-message-body mt-0.5 whitespace-pre-wrap break-words text-sm text-ink"
            dangerouslySetInnerHTML={{ __html: chatMarkdownToHtml(comment.text) }}
          />
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {Object.entries(comment.reactions ?? {}).map(([emoji, userIds]) => (
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

          <div ref={pickerRef} className="relative">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              title="Добавить реакцию"
              className="rounded-full p-1 text-ink-faint opacity-0 hover:bg-surface-hover hover:text-ink group-hover:opacity-100"
            >
              <SmilePlus size={13} />
            </button>
            {pickerOpen && (
              <div className="absolute bottom-full left-0 z-20 mb-1 flex gap-0.5 rounded-lg border border-line/10 bg-surface-panel p-1 shadow-panel">
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

          {isMine && !isEditing && (
            <div className="hidden items-center gap-1 opacity-0 group-hover:flex group-hover:opacity-100">
              <button type="button" onClick={() => setIsEditing(true)} title="Редактировать" className="text-ink-faint hover:text-ink">
                <Pencil size={12} />
              </button>
              <button type="button" onClick={onDelete} title="Удалить" className="text-ink-faint hover:text-red-500">
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
