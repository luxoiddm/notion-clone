'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Upload, FileText, Loader2 } from 'lucide-react';
import { filesApi, withAuthToken, type UserFileInfo } from '../lib/api';

function isImage(mimeType: string) {
  return mimeType.startsWith('image/');
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function FilePickerDialog({
  onClose,
  onPick,
  imagesOnly = false,
}: {
  onClose: () => void;
  onPick: (file: UserFileInfo) => void;
  imagesOnly?: boolean;
}) {
  const [files, setFiles] = useState<UserFileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    filesApi.list().then(setFiles).catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить список'));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleUpload = async (file: File) => {
    setIsUploading(true);
    setError(null);
    try {
      const info = await filesApi.upload(file);
      onPick(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="animate-popIn flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-line/10 bg-surface-panel p-5 shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Вставить файл или изображение</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

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
          className="mb-4 flex items-center justify-center gap-2 rounded-md border border-dashed border-line/20 py-3 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-60"
        >
          {isUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Загрузить новый файл
        </button>

        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}

        <div className="flex-1 space-y-1 overflow-y-auto">
          {files === null ? (
            <p className="py-6 text-center text-sm text-ink-muted">Загрузка...</p>
          ) : (() => {
              const visible = imagesOnly ? files.filter((f) => isImage(f.mimeType)) : files;
              if (visible.length === 0) {
                return (
                  <p className="py-6 text-center text-sm text-ink-faint">
                    {imagesOnly ? 'Изображений в хранилище пока нет — загрузите первое.' : 'В хранилище пока пусто — загрузите первый файл.'}
                  </p>
                );
              }
              return visible.map((f) => (
                <button
                  key={f.fileName}
                  type="button"
                  onClick={() => onPick(f)}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-surface-hover"
                >
                  {isImage(f.mimeType) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={withAuthToken(f.url)} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line/10 bg-surface">
                      <FileText size={14} className="text-ink-faint" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{f.originalName}</span>
                    <span className="block text-xs text-ink-muted">{formatSize(f.size)}</span>
                  </span>
                </button>
              ));
            })()}
        </div>
      </div>
    </div>
  );
}
