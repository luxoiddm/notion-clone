'use client';

import { useEffect, useState } from 'react';
import { X, Link2, Globe, Check, Copy, Trash2, Users, Loader2 } from 'lucide-react';
import { api, filesApi, publicFileUrl, type UserFileInfo } from '../lib/api';
import { Avatar } from './Avatar';

/**
 * Доступ к файлу из личного хранилища: конкретным коллегам или всем
 * сотрудникам (видят его во вкладке «Доступные мне» и открывают по ссылке),
 * и публичная ссылка /f/{token} — открывается без входа, не раскрывает путь
 * к файлу и отзывается в любой момент.
 */
export function FileShareDialog({
  file: initialFile,
  onClose,
  onChanged,
}: {
  file: UserFileInfo;
  onClose: () => void;
  onChanged: (file: UserFileInfo) => void;
}) {
  const [file, setFile] = useState(initialFile);
  const [directory, setDirectory] = useState<{ id: string; displayName: string; avatarUrl: string | null; dismissed?: boolean }[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<'internal' | 'public' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listUsersDirectory()
      .then((users) => setDirectory(users.filter((u) => u.id !== file.ownerId)))
      .catch(() => setDirectory([]));
  }, [file.ownerId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = async (key: string, fn: () => Promise<UserFileInfo>) => {
    setBusy(key);
    setError(null);
    try {
      const updated = await fn();
      setFile(updated);
      onChanged(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(null);
    }
  };

  const everyone = file.sharedWith.includes('*');
  const people = file.sharedWith.filter((id) => id !== '*');
  const setShared = (next: string[]) => apply('sharing', () => filesApi.setSharing(file.fileName, next));

  const copy = async (kind: 'internal' | 'public', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* буфер обмена недоступен */
    }
  };

  // Внутренняя ссылка — БЕЗ токена авторизации: откроется только у тех,
  // у кого есть доступ к файлу и кто вошёл в систему.
  const internalUrl = `${window.location.origin}${file.url}`;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog w-full max-w-[480px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">Доступ к файлу</h2>
            <p className="mt-0.5 truncate text-xs text-ink-muted" title={file.originalName}>
              {file.originalName}
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-icon -mr-2 -mt-1 h-7 w-7" aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>

        {error && <p className="mx-6 mb-3 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

        <div className="px-6">
          <div className="flex gap-2">
            <select value={selected} onChange={(e) => setSelected(e.target.value)} className="input min-w-0 flex-1" disabled={everyone}>
              <option value="">{everyone ? 'Открыт всем сотрудникам' : 'Выберите коллегу…'}</option>
              {directory
                .filter((u) => !u.dismissed && !people.includes(u.id))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName}
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={() => {
                if (!selected) return;
                void setShared([...file.sharedWith, selected]);
                setSelected('');
              }}
              disabled={!selected || busy !== null}
              className="btn-primary h-9"
            >
              Открыть доступ
            </button>
          </div>

          <div className="mt-4">
            <p className="section-label mb-1.5 px-0">Есть доступ</p>
            <div className="-mx-2 max-h-48 space-y-px overflow-y-auto">
              <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
                  <Users size={14} />
                </span>
                <span className="flex-1 text-sm text-ink">Все сотрудники</span>
                <input
                  type="checkbox"
                  checked={everyone}
                  disabled={busy !== null}
                  onChange={(e) => void setShared(e.target.checked ? [...people, '*'] : people)}
                  className="h-4 w-4 accent-[rgb(var(--accent))]"
                />
              </label>
              {people.map((id) => {
                const u = directory.find((d) => d.id === id);
                const name = u?.displayName ?? 'Пользователь';
                return (
                  <div key={id} className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                    <Avatar avatarUrl={u?.avatarUrl ?? null} displayName={name} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{name}</span>
                    <span className="text-xs text-ink-faint">просмотр</span>
                    <button
                      type="button"
                      onClick={() => void setShared(file.sharedWith.filter((x) => x !== id))}
                      disabled={busy !== null}
                      title="Закрыть доступ"
                      className="btn-icon-sm opacity-0 hover:text-danger group-hover:opacity-100"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
              {people.length === 0 && !everyone && <p className="px-2 py-1.5 text-xs text-ink-faint">Пока только вы.</p>}
            </div>
          </div>
        </div>

        {/* Публичная ссылка */}
        <div className="mx-6 mt-4 rounded-lg border border-line/[0.08] bg-surface-panel px-3 py-3">
          <div className="flex items-center gap-3">
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${file.publicToken ? 'bg-accent-soft text-accent-ink' : 'bg-surface-sunken text-ink-faint'}`}
            >
              <Globe size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Публичная ссылка</p>
              <p className="text-xs text-ink-muted">{file.publicToken ? 'Открывается без входа, у любого, у кого есть ссылка' : 'Выключена'}</p>
            </div>
            {file.publicToken ? (
              <button
                type="button"
                onClick={() => void apply('public', () => filesApi.disablePublicLink(file.fileName))}
                disabled={busy !== null}
                className="btn-ghost btn-sm hover:text-danger"
              >
                {busy === 'public' && <Loader2 size={12} className="animate-spin" />}
                Отозвать
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void apply('public', () => filesApi.enablePublicLink(file.fileName))}
                disabled={busy !== null}
                className="btn-secondary btn-sm"
              >
                {busy === 'public' && <Loader2 size={12} className="animate-spin" />}
                Создать
              </button>
            )}
          </div>
          {file.publicToken && (
            <div className="mt-2.5 flex gap-2">
              <input readOnly value={publicFileUrl(file.publicToken)} onFocus={(e) => e.currentTarget.select()} className="input h-8 font-mono text-xs" />
              <button type="button" onClick={() => void copy('public', publicFileUrl(file.publicToken!))} className="btn-secondary btn-sm h-8 shrink-0">
                {copied === 'public' ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                {copied === 'public' ? 'Скопировано' : 'Копировать'}
              </button>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-line/[0.06] bg-surface-panel/60 px-6 py-3">
          <button
            type="button"
            onClick={() => void copy('internal', internalUrl)}
            className="btn-ghost btn-sm -ml-2.5"
            title="Ссылка для сотрудников, у которых есть доступ (нужен вход)"
          >
            {copied === 'internal' ? <Check size={13} className="text-success" /> : <Link2 size={13} />}
            {copied === 'internal' ? 'Скопировано' : 'Внутренняя ссылка'}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary btn-sm">
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}
