'use client';

import { useEffect, useState } from 'react';
import { X, User, Users, Loader2, Check } from 'lucide-react';
import { Avatar } from './Avatar';
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
  const [directory, setDirectory] = useState<{ id: string; displayName: string; avatarUrl?: string | null }[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listUsersDirectory()
      .then((users) => setDirectory(users.filter((u) => u.id !== currentUserId && !u.dismissed)))
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
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog flex max-h-[80vh] w-full max-w-md flex-col p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">Новый чат</h2>
          <button type="button" onClick={onClose} className="btn-icon h-7 w-7">
            <X size={16} />
          </button>
        </div>

        <div className="segmented mb-4 flex w-full">
          <button
            type="button"
            onClick={() => setMode('private')}
            className={clsx(
              'segmented-item h-8 flex-1 text-sm',
              mode === 'private' && 'segmented-item-active',
            )}
          >
            <User size={13} />
            Личный
          </button>
          <button
            type="button"
            onClick={() => setMode('group')}
            className={clsx(
              'segmented-item h-8 flex-1 text-sm',
              mode === 'group' && 'segmented-item-active',
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
                    'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors',
                    selectedUserId === u.id ? 'bg-accent-soft text-ink ring-1 ring-accent/30' : 'text-ink hover:bg-surface-hover',
                  )}
                >
                  <Avatar avatarUrl={u.avatarUrl ?? null} displayName={u.displayName} size="sm" />
                  <span className="flex-1 truncate">{u.displayName}</span>
                  {selectedUserId === u.id && <Check size={15} className="text-accent" />}
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
              className="input"
            />
            <div className="space-y-1">
              {directory.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-faint">Нет других пользователей.</p>
              ) : (
                directory.map((u) => (
                  <label
                    key={u.id}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm text-ink transition-colors hover:bg-surface-hover"
                  >
                    <input
                      type="checkbox"
                      checked={selectedGroupIds.includes(u.id)}
                      onChange={() => toggleGroupMember(u.id)}
                      className="h-4 w-4 accent-[rgb(var(--accent))]"
                    />
                    <Avatar avatarUrl={u.avatarUrl ?? null} displayName={u.displayName} size="sm" />
                    <span className="flex-1 truncate">{u.displayName}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || (mode === 'private' ? !selectedUserId : selectedGroupIds.length === 0)}
          className="btn-primary mt-4 w-full"
        >
          {isSubmitting && <Loader2 size={14} className="animate-spin" />}
          {mode === 'private' ? 'Открыть чат' : 'Создать группу'}
        </button>
      </div>
    </div>
  );
}
