'use client';

import { useEffect, useState } from 'react';
import { X, Download, Share2, ChevronLeft, ChevronRight, FileText, Loader2, Trash2 } from 'lucide-react';
import { fileDownloadUrl } from '../lib/api';

export interface PreviewFile {
  url: string;
  name: string;
  mimeType: string;
  size?: number;
}

type Kind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'other';

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|xml|ya?ml|ini|conf|sql|js|ts|tsx|jsx|py|sh|css|html?)$/i;

function kindOf(f: PreviewFile): Kind {
  const t = f.mimeType || '';
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name)) return 'image';
  if (t === 'application/pdf' || /\.pdf$/i.test(f.name)) return 'pdf';
  if (t.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(f.name)) return 'video';
  if (t.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac)$/i.test(f.name)) return 'audio';
  if (t.startsWith('text/') || t === 'application/json' || TEXT_EXT.test(f.name)) return 'text';
  return 'other';
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function downloadHref(url: string) {
  // Файлы личного хранилища сервер отдаёт как attachment по ?download=1 —
  // так сохраняется исходное (в т.ч. кириллическое) имя.
  return url.startsWith('/api/files/serve/') ? fileDownloadUrl(url) : url;
}

const TEXT_LIMIT = 512 * 1024;

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(false);
    fetch(url, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const blob = await r.blob();
        const body = await blob.slice(0, TEXT_LIMIT).text();
        if (!cancelled) setText(blob.size > TEXT_LIMIT ? `${body}\n\n… файл обрезан, скачайте его целиком` : body);
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (error) return <Unavailable text="Не удалось загрузить файл" />;
  if (text === null) return <Loader2 size={22} className="animate-spin text-white/70" />;
  return (
    <pre className="max-h-full w-full max-w-4xl overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-raised p-5 font-mono text-[13px] leading-relaxed text-ink shadow-lg">
      {text}
    </pre>
  );
}

function Unavailable({ text, file }: { text: string; file?: PreviewFile }) {
  return (
    <div className="flex flex-col items-center rounded-xl bg-surface-raised px-10 py-9 text-center shadow-lg">
      <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
        <FileText size={26} />
      </span>
      <p className="mt-4 max-w-[280px] truncate text-sm font-medium text-ink">{file?.name}</p>
      <p className="mt-1 text-xs text-ink-muted">{text}</p>
      {file && (
        <a href={downloadHref(file.url)} download={file.name} className="btn-primary mt-5">
          <Download size={14} />
          Скачать
        </a>
      )}
    </div>
  );
}

/**
 * Просмотр файла в модальном окне — вместо открытия «голой» ссылки в новой
 * вкладке. Картинки, PDF, видео/аудио и текстовые файлы показываются прямо
 * здесь, остальное — карточка со скачиванием. Файл грузится с cookie
 * сессии, поэтому адрес не содержит токена и вне системы не откроется.
 */
export function FilePreviewDialog({
  file,
  onClose,
  onShare,
  onDelete,
  onPrev,
  onNext,
  position,
}: {
  file: PreviewFile;
  onClose: () => void;
  onShare?: () => void;
  /** Удалить файл (свои файлы) — на телефоне это единственное место, где есть эта кнопка. */
  onDelete?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** «3 из 12» — для листания. */
  position?: string;
}) {
  const kind = kindOf(file);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(false), [file.url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && onPrev) onPrev();
      else if (e.key === 'ArrowRight' && onNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, onPrev, onNext]);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/85 pt-[env(safe-area-inset-top)] backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label={file.name}>
      <div className="flex h-14 shrink-0 items-center gap-3 px-4 text-white" onClick={stop}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/10">
          <FileText size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={file.name}>
            {file.name}
          </p>
          <p className="text-[11px] text-white/55">
            {[file.size != null ? formatFileSize(file.size) : null, position].filter(Boolean).join(' · ')}
          </p>
        </div>
        <a href={downloadHref(file.url)} download={file.name} title="Скачать" className="flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-white/85 hover:bg-white/10 hover:text-white">
          <Download size={15} />
          <span className="hidden sm:inline">Скачать</span>
        </a>
        {onDelete && (
          <button type="button" onClick={onDelete} title="Удалить" aria-label="Удалить" className="flex h-11 w-11 items-center justify-center rounded-md text-white/85 hover:bg-white/10 hover:text-red-300">
            <Trash2 size={17} />
          </button>
        )}
        {onShare && (
          <button type="button" onClick={onShare} title="Доступ и ссылки" className="flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-white/85 hover:bg-white/10 hover:text-white">
            <Share2 size={15} />
            <span className="hidden sm:inline">Поделиться</span>
          </button>
        )}
        <button type="button" onClick={onClose} title="Закрыть (Esc)" className="flex h-9 w-9 items-center justify-center rounded-md text-white/85 hover:bg-white/10 hover:text-white">
          <X size={18} />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-6 sm:px-16">
        {onPrev && (
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              onPrev();
            }}
            title="Предыдущий (←)"
            className="absolute left-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <ChevronLeft size={20} />
          </button>
        )}
        {onNext && (
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              onNext();
            }}
            title="Следующий (→)"
            className="absolute right-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <ChevronRight size={20} />
          </button>
        )}

        <div className="flex h-full w-full items-center justify-center" onClick={kind === 'image' || kind === 'other' ? undefined : stop}>
          {kind === 'image' && (
            <>
              {!loaded && <Loader2 size={22} className="absolute animate-spin text-white/70" />}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={file.url}
                src={file.url}
                alt={file.name}
                onLoad={() => setLoaded(true)}
                onClick={stop}
                className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
              />
            </>
          )}
          {kind === 'pdf' && <iframe key={file.url} src={file.url} title={file.name} className="h-full w-full max-w-5xl rounded-lg bg-white shadow-2xl" />}
          {kind === 'video' && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video key={file.url} src={file.url} controls autoPlay className="max-h-full max-w-full rounded-lg shadow-2xl" />
          )}
          {kind === 'audio' && (
            <div className="w-full max-w-md rounded-xl bg-surface-raised p-6 shadow-lg">
              <p className="mb-3 truncate text-sm font-medium text-ink">{file.name}</p>
              <audio key={file.url} src={file.url} controls autoPlay className="w-full" />
            </div>
          )}
          {kind === 'text' && <TextPreview url={file.url} />}
          {kind === 'other' && (
            <div onClick={stop}>
              <Unavailable text="Предпросмотр для этого типа файла недоступен" file={file} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
