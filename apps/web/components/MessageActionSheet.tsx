'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircle, Copy, Pencil, Trash2, Download } from 'lucide-react';
import { type ChatMessage, fileDownloadUrl } from '../lib/api';
import { formatDuration } from '../lib/mediaRecorder';

function describe(m: ChatMessage): string {
  if (m.attachment?.kind === 'voice') return `Голосовое · ${formatDuration(m.attachment.duration ?? 0)}`;
  if (m.attachment?.kind === 'round') return `Кружок · ${formatDuration(m.attachment.duration ?? 0)}`;
  if (m.text) return m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text;
  if (m.gif) return 'GIF';
  if (m.attachment) return m.attachment.fileName;
  if (m.pageRef) return 'Ссылка на страницу';
  return 'Сообщение';
}

/**
 * Меню действий с сообщением — по долгому нажатию (телефон) или правой
 * кнопке мыши. Нужно прежде всего для кружков, голосовых и картинок: у них
 * обычное нажатие уже занято (просмотр / воспроизведение), а панель при
 * наведении на телефоне не появляется. На телефоне — шторка снизу, на
 * компьютере — небольшое окно по центру.
 */
export function MessageActionSheet({
  message,
  isMine,
  reactions,
  myReactions,
  onReact,
  onThread,
  onEdit,
  onDelete,
  onCopied,
  onClose,
}: {
  message: ChatMessage;
  isMine: boolean;
  reactions: string[];
  myReactions: string[];
  onReact: (emoji: string) => void;
  onThread?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onCopied: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const item = 'flex min-h-[48px] w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] text-ink hover:bg-surface-hover md:min-h-[40px] md:text-sm';

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex animate-fadeIn items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
      data-no-swipe-back
    >
      <div
        role="menu"
        aria-label="Действия с сообщением"
        onClick={(e) => e.stopPropagation()}
        className="w-full animate-popIn rounded-t-2xl bg-surface-raised p-2 shadow-dialog md:w-80 md:rounded-xl"
        style={{ paddingBottom: 'max(8px, var(--safe-bottom, 0px))' }}
      >
        <span className="mx-auto mb-2 mt-1 block h-1 w-9 rounded-full bg-line/15 md:hidden" aria-hidden />
        <p className="truncate px-3 pb-2 text-xs text-ink-muted">{describe(message)}</p>
        <div className="mb-1 flex justify-between gap-1 border-b border-line/[0.08] px-1 pb-2">
          {reactions.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={run(() => onReact(emoji))}
              aria-label={`Реакция ${emoji}`}
              className={`flex h-11 w-11 items-center justify-center rounded-full text-[22px] transition-transform active:scale-90 md:h-9 md:w-9 md:text-lg ${
                myReactions.includes(emoji) ? 'bg-accent-soft' : 'hover:bg-surface-hover'
              }`}
            >
              {emoji}
            </button>
          ))}
        </div>
        {onThread && (
          <button type="button" role="menuitem" onClick={run(onThread)} className={item}>
            <MessageCircle size={18} className="text-ink-muted" />
            Ответить в теме
          </button>
        )}
        {message.text && (
          <button
            type="button"
            role="menuitem"
            onClick={run(() => {
              void navigator.clipboard?.writeText(message.text).then(onCopied, () => undefined);
            })}
            className={item}
          >
            <Copy size={18} className="text-ink-muted" />
            Копировать текст
          </button>
        )}
        {message.attachment && (
          <a role="menuitem" href={fileDownloadUrl(message.attachment.url)} download={message.attachment.fileName} onClick={onClose} className={item}>
            <Download size={18} className="text-ink-muted" />
            Скачать
          </a>
        )}
        {isMine && onEdit && message.text && (
          <button type="button" role="menuitem" onClick={run(onEdit)} className={item}>
            <Pencil size={18} className="text-ink-muted" />
            Редактировать
          </button>
        )}
        {isMine && onDelete && (
          <button type="button" role="menuitem" onClick={run(onDelete)} className={`${item} text-danger hover:bg-danger/10`}>
            <Trash2 size={18} />
            Удалить
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
