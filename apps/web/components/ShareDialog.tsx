'use client';

import { useEffect, useState } from 'react';
import { X, Link2, Trash2, Check } from 'lucide-react';
import { api } from '../lib/api';
import type { PageMeta } from '../lib/types';
import { Avatar } from './Avatar';

type AccessLevel = 'read' | 'comment' | 'edit' | 'admin';

const LEVEL_LABEL: Record<AccessLevel, string> = {
  read: 'Чтение',
  comment: 'Комментирование',
  edit: 'Редактирование',
  admin: 'Полный доступ',
};

export function ShareDialog({
  ownerId,
  projectId,
  pageId,
  sharing: initialSharing,
  onClose,
  onChanged,
}: {
  ownerId: string;
  projectId: string;
  pageId: string;
  sharing: PageMeta['sharing'];
  onClose: () => void;
  onChanged: (sharing: PageMeta['sharing']) => void;
}) {
  // Локальная копия — чтобы список доступа обновлялся сразу после
  // сохранения, не дожидаясь перезагрузки метаданных страницы снаружи.
  const [sharing, setSharing] = useState(initialSharing);
  const [directory, setDirectory] = useState<{ id: string; displayName: string; avatarUrl: string | null; dismissed?: boolean }[]>([]);
  const [copied, setCopied] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [level, setLevel] = useState<AccessLevel>('edit');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    api
      .listUsersDirectory()
      .then((users) => setDirectory(users.filter((u) => u.id !== ownerId)))
      .catch(() => setDirectory([]));
  }, [ownerId]);

  const persist = async (next: PageMeta['sharing']) => {
    setIsSaving(true);
    try {
      const updated = await api.updateSharing(ownerId, projectId, pageId, next);
      setSharing(updated.sharing);
      onChanged(updated.sharing);
    } finally {
      setIsSaving(false);
    }
  };

  const addGrant = () => {
    if (!selectedUserId) return;
    const next = [...sharing.filter((s) => s.userId !== selectedUserId), { userId: selectedUserId, level }];
    void persist(next);
    setSelectedUserId('');
  };

  const addLinkAccess = () => {
    const next = [...sharing.filter((s) => s.userId !== '*'), { userId: '*', level: 'read' as AccessLevel }];
    void persist(next);
  };

  const removeGrant = (userId: string) => {
    void persist(sharing.filter((s) => s.userId !== userId));
  };

  const changeLevel = (userId: string, nextLevel: AccessLevel) => {
    void persist(sharing.map((s) => (s.userId === userId ? { ...s, level: nextLevel } : s)));
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* буфер обмена недоступен — молча игнорируем */
    }
  };

  const linkGrant = sharing.find((s) => s.userId === '*');
  const peopleGrants = sharing.filter((s) => s.userId !== '*');

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog w-full max-w-[480px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
          <div>
            <h2 className="text-base font-semibold text-ink">Поделиться страницей</h2>
            <p className="mt-0.5 text-xs text-ink-muted">Пригласите коллег и выберите уровень доступа.</p>
          </div>
          <button type="button" onClick={onClose} className="btn-icon -mr-2 -mt-1 h-7 w-7" aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>

        <div className="px-6">
          <div className="flex flex-col gap-2 sm:flex-row">
            <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} className="input min-w-0 flex-1">
              <option value="">Выберите коллегу…</option>
              {directory
                .filter((u) => !u.dismissed && !sharing.some((s) => s.userId === u.id))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName}
                  </option>
                ))}
            </select>
            <div className="flex gap-2">
              <select value={level} onChange={(e) => setLevel(e.target.value as AccessLevel)} className="input w-auto min-w-0 flex-1 sm:flex-none">
                {(Object.keys(LEVEL_LABEL) as AccessLevel[]).map((l) => (
                  <option key={l} value={l}>
                    {LEVEL_LABEL[l]}
                  </option>
                ))}
              </select>
              <button type="button" onClick={addGrant} disabled={!selectedUserId || isSaving} className="btn-primary h-9">
                Пригласить
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 px-6">
          <p className="section-label mb-1.5 px-0">Есть доступ</p>
          <div className="-mx-2 max-h-56 space-y-px overflow-y-auto">
            {peopleGrants.length === 0 && <p className="px-2 py-3 text-sm text-ink-faint">Пока только вы.</p>}
            {peopleGrants.map((grant) => {
              const person = directory.find((u) => u.id === grant.userId);
              const name = person?.displayName ?? grant.userId;
              return (
                <div key={grant.userId} className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                  <Avatar avatarUrl={person?.avatarUrl ?? null} displayName={name} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{name}</span>
                  <select
                    value={grant.level}
                    onChange={(e) => changeLevel(grant.userId, e.target.value as AccessLevel)}
                    disabled={isSaving}
                    className="h-7 cursor-pointer rounded-md border-0 bg-transparent pr-1 text-xs text-ink-muted outline-none hover:text-ink"
                  >
                    {(Object.keys(LEVEL_LABEL) as AccessLevel[]).map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_LABEL[l]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeGrant(grant.userId)}
                    title="Закрыть доступ"
                    className="btn-icon-sm opacity-0 hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mx-6 mt-4 flex items-center gap-3 rounded-lg border border-line/[0.08] bg-surface-panel px-3 py-2.5">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${linkGrant ? 'bg-accent-soft text-accent-ink' : 'bg-surface-sunken text-ink-faint'}`}>
            <Link2 size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">Доступ по ссылке</p>
            <p className="text-xs text-ink-muted">{linkGrant ? 'Все сотрудники могут читать страницу' : 'Только приглашённые'}</p>
          </div>
          {linkGrant ? (
            <button type="button" onClick={() => removeGrant('*')} disabled={isSaving} className="btn-ghost btn-sm">
              Выключить
            </button>
          ) : (
            <button type="button" onClick={addLinkAccess} disabled={isSaving} className="btn-secondary btn-sm">
              Включить
            </button>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3 border-t border-line/[0.06] bg-surface-panel/60 px-6 py-3">
          <button type="button" onClick={() => void copyLink()} className="btn-ghost btn-sm -ml-2.5">
            {copied ? <Check size={13} className="text-success" /> : <Link2 size={13} />}
            {copied ? 'Скопировано' : 'Копировать ссылку'}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary btn-sm">
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}
