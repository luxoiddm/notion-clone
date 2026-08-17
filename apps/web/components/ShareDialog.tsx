'use client';

import { useEffect, useState } from 'react';
import { X, Link2, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { PageMeta } from '../lib/types';

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
  sharing,
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
  const [directory, setDirectory] = useState<{ id: string; displayName: string }[]>([]);
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="animate-popIn w-full max-w-md rounded-xl border border-line/10 bg-surface-panel p-5 shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Доступ к странице</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="mb-4 space-y-2">
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="w-full rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          >
            <option value="">Выбрать пользователя...</option>
            {directory
              .filter((u) => !sharing.some((s) => s.userId === u.id))
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
          </select>
          <div className="flex gap-2">
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as AccessLevel)}
              className="min-w-0 flex-1 rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
            >
              {(Object.keys(LEVEL_LABEL) as AccessLevel[]).map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABEL[l]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addGrant}
              disabled={!selectedUserId || isSaving}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
            >
              Дать доступ
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={addLinkAccess}
          disabled={isSaving}
          className="mb-4 flex w-full items-center gap-2 rounded-md border border-dashed border-line/20 px-3 py-2 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          <Link2 size={14} />
          Разрешить всем по ссылке (только чтение)
        </button>

        <div className="space-y-1">
          {sharing.length === 0 && <p className="text-sm text-ink-faint">Доступ пока никому не выдан.</p>}
          {sharing.map((grant) => (
            <div key={grant.userId} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover">
              <span className="text-ink">
                {grant.userId === '*' ? 'Все по ссылке' : directory.find((u) => u.id === grant.userId)?.displayName ?? grant.userId}
                <span className="ml-2 text-xs text-ink-muted">{LEVEL_LABEL[grant.level]}</span>
              </span>
              <button type="button" onClick={() => removeGrant(grant.userId)} className="rounded p-1 text-ink-faint hover:bg-surface hover:text-red-500">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
