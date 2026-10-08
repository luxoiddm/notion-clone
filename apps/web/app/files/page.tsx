'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, FolderOpen, Globe, LayoutGrid, List, Loader2, Search, Share2, Trash2, Upload, Users } from 'lucide-react';
import { useSession } from '../../components/SessionProvider';
import { api, filesApi, fileDownloadUrl, type UserFileInfo } from '../../lib/api';
import { FilePreviewDialog } from '../../components/FilePreviewDialog';
import { FileShareDialog } from '../../components/FileShareDialog';
import { useToast, ToastProvider } from '../../components/Toast';
import { AppShell, FullScreenLoader, SignInRequired } from '../../components/AppShell';

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
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [dragOver, setDragOver] = useState(false);
  const [tab, setTab] = useState<'mine' | 'shared'>('mine');
  const [sharedFiles, setSharedFiles] = useState<UserFileInfo[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [shareFile, setShareFile] = useState<UserFileInfo | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  const refresh = useCallback(() => {
    filesApi.list().then(setFiles).catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить список'));
    filesApi.listShared().then(setSharedFiles).catch(() => setSharedFiles([]));
    api
      .listUsersDirectory()
      .then((users) => setNames(new Map(users.map((u) => [u.id, u.displayName]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (user) refresh();
  }, [user, refresh]);

  if (sessionLoading) {
    return <FullScreenLoader />;
  }

  if (!user) {
    return <SignInRequired />;
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

  const current = tab === 'mine' ? files : sharedFiles;
  const visible = (current ?? []).filter((f) => !filter.trim() || f.originalName.toLowerCase().includes(filter.trim().toLowerCase()));
  const totalSize = (current ?? []).reduce((sum, f) => sum + f.size, 0);
  const onFileChanged = (updated: UserFileInfo) => {
    setFiles((prev) => prev?.map((f) => (f.fileName === updated.fileName ? updated : f)) ?? null);
    setShareFile(updated);
  };
  const keyOf = (f: UserFileInfo) => `${f.ownerId}/${f.fileName}`;
  const tileProps = (file: UserFileInfo): FileItemProps =>
    tab === 'mine'
      ? { file, onOpen: () => setPreviewKey(keyOf(file)), onDelete: () => handleDelete(file), onShare: () => setShareFile(file) }
      : { file, onOpen: () => setPreviewKey(keyOf(file)), ownerName: names.get(file.ownerId) ?? 'Коллега' };
  const previewIndex = previewKey ? visible.findIndex((f) => keyOf(f) === previewKey) : -1;
  const previewFile = previewIndex >= 0 ? visible[previewIndex]! : null;
  const go = (delta: number) => {
    const next = visible[(previewIndex + delta + visible.length) % visible.length];
    if (next) setPreviewKey(keyOf(next));
  };

  return (
    <AppShell
      title="Файлы"
      icon={<FolderOpen size={19} />}
      description="Личное хранилище — файлы отсюда вставляются в любую статью командами «/Изображение» и «/Файл»."
      width="wide"
      fab={{ icon: isUploading ? <Loader2 size={22} className="animate-spin" /> : <Upload size={22} />, label: 'Загрузить', onClick: () => inputRef.current?.click(), extended: true }}
      actions={
        <button type="button" onClick={() => inputRef.current?.click()} disabled={isUploading} className="btn-primary">
          {isUploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          Загрузить
        </button>
      }
    >
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

      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleUpload(file);
        }}
        className={`rounded-xl transition-[box-shadow,background-color] ${dragOver ? 'bg-accent-soft/40 ring-2 ring-accent/40 ring-offset-4 ring-offset-surface' : ''}`}
      >
        <div className="mb-5 flex gap-1 border-b border-line/[0.07]">
          {(
            [
              ['mine', 'Мои файлы', files?.length],
              ['shared', 'Доступные мне', sharedFiles?.length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors ${
                tab === key ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {label}
              {!!count && <span className="badge h-[18px] px-1.5">{count}</span>}
            </button>
          ))}
        </div>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-xs">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Найти файл" className="input pl-8" />
          </div>
          <div className="flex items-center gap-3">
            {current && current.length > 0 && (
              <span className="text-xs text-ink-faint">
                {current.length} · {formatSize(totalSize)}
              </span>
            )}
            <div className="segmented">
              <button type="button" onClick={() => setView('grid')} title="Плиткой" className={`segmented-item px-2 ${view === 'grid' ? 'segmented-item-active' : ''}`}>
                <LayoutGrid size={14} />
              </button>
              <button type="button" onClick={() => setView('list')} title="Списком" className={`segmented-item px-2 ${view === 'list' ? 'segmented-item-active' : ''}`}>
                <List size={14} />
              </button>
            </div>
          </div>
        </div>

        {error && <p className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        {current === null ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton aspect-[4/3] animate-shimmer rounded-xl" />
            ))}
          </div>
        ) : current.length === 0 && tab === 'shared' ? (
          <p className="rounded-xl border border-dashed border-line/[0.12] px-6 py-14 text-center text-sm text-ink-muted">
            Коллеги пока не открывали вам доступ к своим файлам.
          </p>
        ) : current.length === 0 ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full flex-col items-center rounded-xl border border-dashed border-line/[0.14] px-6 py-16 text-center transition-colors hover:border-accent/40 hover:bg-accent-soft/20"
          >
            <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
              <Upload size={20} />
            </span>
            <span className="text-sm font-medium text-ink">Перетащите файл сюда</span>
            <span className="mt-1 text-sm text-ink-muted">или нажмите, чтобы выбрать на компьютере</span>
          </button>
        ) : visible.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-muted">Ничего не найдено по «{filter}»</p>
        ) : view === 'grid' ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {visible.map((file) => (
              <FileTile key={`${file.ownerId}/${file.fileName}`} {...tileProps(file)} />
            ))}
          </ul>
        ) : (
          <ul className="card divide-y divide-line/[0.06] overflow-hidden">
            {visible.map((file) => (
              <FileRow key={`${file.ownerId}/${file.fileName}`} {...tileProps(file)} />
            ))}
          </ul>
        )}

        {tab === 'mine' && <p className="mt-6 text-center text-xs text-ink-faint">Можно перетащить файл прямо на эту страницу.</p>}
      </div>

      {previewFile && (
        <FilePreviewDialog
          file={{ url: previewFile.url, name: previewFile.originalName, mimeType: previewFile.mimeType, size: previewFile.size }}
          onClose={() => setPreviewKey(null)}
          onShare={tab === 'mine' ? () => setShareFile(previewFile) : undefined}
          onDelete={
            tab === 'mine'
              ? () => {
                  setPreviewKey(null);
                  void handleDelete(previewFile);
                }
              : undefined
          }
          onPrev={visible.length > 1 ? () => go(-1) : undefined}
          onNext={visible.length > 1 ? () => go(1) : undefined}
          position={visible.length > 1 ? `${previewIndex + 1} из ${visible.length}` : undefined}
        />
      )}
      {shareFile && <FileShareDialog file={shareFile} onClose={() => setShareFile(null)} onChanged={onFileChanged} />}
    </AppShell>
  );
}

function fileExt(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase().slice(0, 4) : 'FILE';
}

type FileItemProps = {
  file: UserFileInfo;
  /** Открыть просмотр в модальном окне. */
  onOpen: () => void;
  /** Только для своих файлов. */
  onDelete?: () => void;
  onShare?: () => void;
  /** Для файлов коллег — чей файл. */
  ownerName?: string;
};

/** Значки «кому открыт» на своих файлах. */
function SharingBadges({ file }: { file: UserFileInfo }) {
  if (!file.sharedWith.length && !file.publicToken) return null;
  return (
    <span className="flex items-center gap-1 text-ink-faint">
      {file.sharedWith.length > 0 && (
        <span title={file.sharedWith.includes('*') ? 'Открыт всем сотрудникам' : `Открыт: ${file.sharedWith.length}`}>
          <Users size={12} />
        </span>
      )}
      {file.publicToken && (
        <span title="Есть публичная ссылка" className="text-accent">
          <Globe size={12} />
        </span>
      )}
    </span>
  );
}

function FileTile({ file, onOpen, onDelete, onShare, ownerName }: FileItemProps) {
  return (
    <li className="group card overflow-hidden transition-[box-shadow,transform] hover:-translate-y-px hover:shadow-pop">
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
        title="Открыть просмотр"
        className="relative block aspect-[4/3] cursor-pointer overflow-hidden bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
      >
        {isImage(file.mimeType) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={file.url} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-2 text-ink-faint">
            <FileText size={28} strokeWidth={1.5} />
            <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-2xs font-medium text-ink-muted shadow-xs">{fileExt(file.originalName)}</span>
          </span>
        )}
        <span className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <a
            href={fileDownloadUrl(file.url)}
            download={file.originalName}
            onClick={(e) => e.stopPropagation()}
            title="Скачать"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-raised/90 text-ink-muted shadow-pop backdrop-blur hover:text-ink"
          >
            <Download size={13} />
          </a>
          {onShare && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onShare();
              }}
              title="Доступ и ссылки"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-raised/90 text-ink-muted shadow-pop backdrop-blur hover:text-ink"
            >
              <Share2 size={13} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              title="Удалить"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-raised/90 text-ink-muted shadow-pop backdrop-blur hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          )}
        </span>
      </div>
      <div className="px-3 py-2.5">
        <p className="truncate text-sm font-medium text-ink" title={file.originalName}>
          {file.originalName}
        </p>
        <p className="mt-0.5 flex items-center justify-between gap-2 text-2xs text-ink-faint">
          <span className="truncate">
            {ownerName ? `${ownerName} · ` : ''}
            {formatSize(file.size)} · {new Date(file.uploadedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
          </span>
          {!ownerName && <SharingBadges file={file} />}
        </p>
      </div>
    </li>
  );
}

function FileRow({ file, onOpen, onDelete, onShare, ownerName }: FileItemProps) {
  return (
    <li className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover">
      {isImage(file.mimeType) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={file.url} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-ink-faint">
          <FileText size={16} />
        </span>
      )}
      <button type="button" onClick={onOpen} title="Открыть просмотр" className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium text-ink">{file.originalName}</span>
        <span className="flex items-center gap-2 text-2xs text-ink-faint">
          {ownerName ? `${ownerName} · ` : ''}
          {formatSize(file.size)} · {new Date(file.uploadedAt).toLocaleDateString('ru-RU')}
          {!ownerName && <SharingBadges file={file} />}
        </span>
      </button>
      <a href={fileDownloadUrl(file.url)} download={file.originalName} title="Скачать" className="btn-icon">
        <Download size={14} />
      </a>
      {onShare && (
        <button type="button" onClick={onShare} title="Доступ и ссылки" className="btn-icon">
          <Share2 size={14} />
        </button>
      )}
      {onDelete && (
        <button type="button" onClick={onDelete} title="Удалить" className="btn-icon hover:text-danger">
          <Trash2 size={14} />
        </button>
      )}
    </li>
  );
}
