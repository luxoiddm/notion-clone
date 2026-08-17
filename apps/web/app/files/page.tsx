'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Upload, FileText, Trash2, Copy, Check, Loader2, FolderOpen } from 'lucide-react';
import { useSession } from '../../components/SessionProvider';
import { filesApi, withAuthToken, type UserFileInfo } from '../../lib/api';
import { useToast, ToastProvider } from '../../components/Toast';

function isImage(mimeType: string) {
  return mimeType.startsWith('image/');
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export default function FilesPage() {
  return (
    <ToastProvider>
      <FilesManager />
    </ToastProvider>
  );
}

function FilesManager() {
  const { user, isLoading: sessionLoading } = useSession();
  const { push } = useToast();
  const [files, setFiles] = useState<UserFileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    filesApi.list().then(setFiles).catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить список'));
  }, []);

  useEffect(() => {
    if (user) refresh();
  }, [user, refresh]);

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

  const handleUpload = async (file: File) => {
    setIsUploading(true);
    setError(null);
    try {
      await filesApi.upload(file);
      refresh();
      push('Файл загружен', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (file: UserFileInfo) => {
    if (!confirm(`Удалить «${file.originalName}»? Если файл уже вставлен в какую-то статью, там он перестанет открываться.`)) return;
    try {
      await filesApi.remove(file.fileName);
      setFiles((prev) => prev?.filter((f) => f.fileName !== file.fileName) ?? null);
      push('Файл удалён', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось удалить файл', 'error');
    }
  };

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-6 py-10 sm:px-10">
      <Link href="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft size={14} />
        Назад в рабочее пространство
      </Link>

      <h1 className="mb-1 flex items-center gap-2 text-2xl font-bold text-ink">
        <FolderOpen size={22} className="text-accent" />
        Моё файловое хранилище
      </h1>
      <p className="mb-6 text-sm text-ink-muted">
        Файлы отсюда можно вставлять в любую статью через команду «/Изображение» или «/Файл». Хранилище общее для всех
        ваших статей — загруженное здесь никуда не пропадает, даже если вы его не вставили ни в один документ.
      </p>

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUpload(file);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
        className="mb-6 flex items-center gap-2 rounded-md border border-dashed border-line/20 px-4 py-3 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-60"
      >
        {isUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
        Загрузить файл
      </button>

      {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

      {files === null ? (
        <p className="text-sm text-ink-muted">Загрузка...</p>
      ) : files.length === 0 ? (
        <p className="rounded-lg border border-line/10 bg-surface-panel p-6 text-center text-sm text-ink-muted">
          В хранилище пока пусто.
        </p>
      ) : (
        <ul className="space-y-1">
          {files.map((file) => (
            <FileRow key={file.fileName} file={file} onDelete={() => handleDelete(file)} onCopied={() => push('Ссылка скопирована', 'info')} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FileRow({ file, onDelete, onCopied }: { file: UserFileInfo; onDelete: () => void; onCopied: () => void }) {
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      // Note: the token embedded in this URL is short-lived (~15 min) —
      // fine for pasting into a document you're editing right now, not a
      // permanent public link. Re-open this page later for a fresh one.
      await navigator.clipboard.writeText(window.location.origin + withAuthToken(file.url));
      setCopied(true);
      onCopied();
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (permissions, non-HTTPS) — fail silently, the button just won't confirm.
    }
  };

  return (
    <li className="flex items-center gap-3 rounded-lg border border-line/10 bg-surface-panel px-4 py-3">
      {isImage(file.mimeType) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={withAuthToken(file.url)} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line/10 bg-surface">
          <FileText size={16} className="text-ink-faint" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">{file.originalName}</span>
        <span className="block text-xs text-ink-muted">
          {formatSize(file.size)} · {new Date(file.uploadedAt).toLocaleDateString('ru-RU')}
        </span>
      </span>
      <button type="button" onClick={copyLink} title="Скопировать ссылку" className="rounded p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink">
        {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
      </button>
      <button type="button" onClick={onDelete} title="Удалить" className="rounded p-1.5 text-ink-muted hover:bg-surface-hover hover:text-red-500">
        <Trash2 size={14} />
      </button>
    </li>
  );
}
