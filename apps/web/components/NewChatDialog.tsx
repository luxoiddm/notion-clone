'use client';

import { useEffect, useState } from 'react';
import { X, User, Users, Loader2 } from 'lucide-react';
import { api, chatApi, type ChatSummary } from '../lib/api';
import clsx from 'clsx';

type Mode = 'private' | 'group';

export function NewChatDialog({
  currentUserId,
  onClose,
  onCreated,
}: {
  currentUserId: string;
  onClose: () => void;
  onCreated: (chat: ChatSummary) => void;
}) {
  const [mode, setMode] = useState<Mode>('private');
  const [directory, setDirectory] = useState<{ id: string; displayName: string }[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listUsersDirectory()
      .then((users) => setDirectory(users.filter((u) => u.id !== currentUserId)))
      .catch(() => setDirectory([]));
  }, [currentUserId]);

  const toggleGroupMember = (userId: string) => {
    setSelectedGroupIds((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));
  };

  const handleSubmit = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      if (mode === 'private') {
        if (!selectedUserId) return setError('Выберите собеседника');
        const chat = await chatApi.getOrCreatePrivate(selectedUserId);
        onCreated(chat);
      } else {
        if (selectedGroupIds.length === 0) return setError('Выберите хотя бы одного участника');
        const chat = await chatApi.createGroup({
          name: groupName.trim() || null,
          memberIds: [currentUserId, ...selectedGroupIds],
        });
        onCreated(chat);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать чат');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="animate-popIn flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-line/10 bg-surface-panel p-5 shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Новый чат</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="mb-4 flex gap-0.5 rounded-lg border border-line/10 bg-surface p-0.5">
          <button
            type="button"
            onClick={() => setMode('private')}
            className={clsx(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm',
              mode === 'private' ? 'bg-surface-panel text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            <User size={13} />
            Личный
          </button>
          <button
            type="button"
            onClick={() => setMode('group')}
            className={clsx(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm',
              mode === 'group' ? 'bg-surface-panel text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            <Users size={13} />
            Групповой
          </button>
        </div>

        {mode === 'private' ? (
          <div className="flex-1 space-y-1 overflow-y-auto">
            {directory.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-faint">Нет других пользователей.</p>
            ) : (
              directory.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setSelectedUserId(u.id)}
                  className={clsx(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    selectedUserId === u.id ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                  )}
                >
                  {u.displayName}
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="flex-1 space-y-3 overflow-y-auto">
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Название группы (необязательно)"
              className="w-full rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
            />
            <div className="space-y-1">
              {directory.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-faint">Нет других пользователей.</p>
              ) : (
                directory.map((u) => (
                  <label
                    key={u.id}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink"
                  >
                    <input
                      type="checkbox"
                      checked={selectedGroupIds.includes(u.id)}
                      onChange={() => toggleGroupMember(u.id)}
                      className="h-4 w-4 accent-[rgb(var(--accent))]"
                    />
                    {u.displayName}
                  </label>
                ))
              )}
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="mt-4 flex items-center justify-center gap-2 rounded-md bg-accent py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {isSubmitting && <Loader2 size={14} className="animate-spin" />}
          {mode === 'private' ? 'Открыть чат' : 'Создать группу'}
        </button>
      </div>
    </div>
  );
}
