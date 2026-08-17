'use client';

import { useState } from 'react';
import { FileText, X, Download } from 'lucide-react';
import { withAuthToken, type ChatAttachment } from '../lib/api';

function isImage(mimeType: string) {
  return mimeType.startsWith('image/');
}

function isVideo(mimeType: string) {
  return mimeType.startsWith('video/');
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function ChatAttachmentView({ attachment }: { attachment: ChatAttachment }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const src = withAuthToken(attachment.url);

  if (isImage(attachment.mimeType)) {
    return (
      <>
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="mt-1 block max-w-[220px] overflow-hidden rounded-lg border border-line/10"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={attachment.fileName} className="max-h-56 w-full object-cover" />
        </button>

        {lightboxOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
            onClick={() => setLightboxOpen(false)}
          >
            <button
              type="button"
              onClick={() => setLightboxOpen(false)}
              title="Закрыть"
              className="absolute right-4 top-4 rounded-full bg-black/40 p-2 text-white hover:bg-black/60"
            >
              <X size={18} />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={attachment.fileName}
              className="max-h-full max-w-full rounded-lg object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </>
    );
  }

  if (isVideo(attachment.mimeType)) {
    // Native <video controls> already plays on click and has its own
    // fullscreen button — no separate lightbox needed the way images do.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <video src={src} controls className="mt-1 max-h-64 max-w-[280px] rounded-lg border border-line/10" />;
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      download={attachment.fileName}
      className="mt-1 flex max-w-[240px] items-center gap-2 rounded-lg border border-line/10 bg-surface px-2.5 py-2 text-xs hover:bg-surface-hover"
    >
      <FileText size={16} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">{attachment.fileName}</span>
        <span className="block text-ink-faint">{formatSize(attachment.size)}</span>
      </span>
      <Download size={13} className="shrink-0 text-ink-faint" />
    </a>
  );
}
