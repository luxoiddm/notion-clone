'use client';

import { useState } from 'react';
import { FileText, Eye } from 'lucide-react';
import { type ChatAttachment } from '../lib/api';
import { FilePreviewDialog, formatFileSize } from './FilePreviewDialog';
import { VoiceMessage, RoundVideoMessage } from './ChatMediaMessage';

/**
 * Вложение в сообщении чата. Картинка — превью, остальное — карточка;
 * клик открывает просмотр в модальном окне (не новую вкладку). Файл
 * грузится с cookie сессии — в адресе нет токена.
 */
export function ChatAttachmentView({ attachment, isMine = false }: { attachment: ChatAttachment; isMine?: boolean }) {
  const [open, setOpen] = useState(false);
  if (attachment.kind === 'voice') return <VoiceMessage attachment={attachment} isMine={isMine} />;
  if (attachment.kind === 'round') return <RoundVideoMessage attachment={attachment} />;
  const isImage = attachment.mimeType.startsWith('image/');
  const isVideo = attachment.mimeType.startsWith('video/');

  const preview = open && (
    <FilePreviewDialog
      file={{ url: attachment.url, name: attachment.fileName, mimeType: attachment.mimeType, size: attachment.size }}
      onClose={() => setOpen(false)}
    />
  );

  if (isImage) {
    return (
      <>
        <button type="button" onClick={() => setOpen(true)} className="mt-1 block max-w-[220px] cursor-zoom-in overflow-hidden rounded-lg border border-line/10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={attachment.url} alt={attachment.fileName} className="max-h-56 w-full object-cover" />
        </button>
        {preview}
      </>
    );
  }

  if (isVideo) {
    // Native <video controls> already plays inline and has its own fullscreen button.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <video src={attachment.url} controls className="mt-1 max-h-64 max-w-[280px] rounded-lg border border-line/10" />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 flex max-w-[260px] items-center gap-2 rounded-lg border border-line/[0.08] bg-surface-raised px-2.5 py-2 text-left text-xs text-ink shadow-xs hover:bg-surface-hover"
      >
        <FileText size={16} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{attachment.fileName}</span>
          <span className="block text-ink-faint">{formatFileSize(attachment.size)}</span>
        </span>
        <Eye size={13} className="shrink-0 text-ink-faint" />
      </button>
      {preview}
    </>
  );
}
