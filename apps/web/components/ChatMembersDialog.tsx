'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, UserPlus, LogOut, Loader2, Check, Search, Crown, UserMinus } from 'lucide-react';
import clsx from 'clsx';
import { chatApi, type ChatSummary } from '../lib/api';
import type { CurrentUser } from '../lib/types';
import { Avatar } from './Avatar';

type Directory = Map<string, { displayName: string; avatarUrl: string | null }>;

/**
 * Права на состав чата (зеркалят проверку на сервере, см. chat.routes.ts):
 * добавлять и исключать участников может создатель чата, а также Admin и
 * Team-Lead — если они сами участвуют в этом чате. Выйти может любой.
 */
export function canManageChatMembers(chat: ChatSummary, user: CurrentUser): boolean {
  if (!chat.memberIds.includes(user.id)) return false;
  return user.role === 'Admin' || user.role === 'Team-Lead' || (!!chat.createdBy && chat.createdBy === user.id);
}

export function ChatMembersDialog({
  chat,
  currentUser,
  usersById,
  onClose,
  onChanged,
  onLeft,
  initialMode = 'list',
}: {
  /** 'add' — открыть сразу окно добавления (кнопка «Добавить участников» в шапке чата). */
  initialMode?: 'list' | 'add';
  chat: ChatSummary;
  currentUser: CurrentUser;
  usersById: Directory;
  onClose: () => void;
  /** Состав изменился — обновить список чатов. */
  onChanged: () => void;
  /** Текущий пользователь вышел из чата. */
  onLeft: () => void;
}) {
  const canManage = canManageChatMembers(chat, currentUser);
  const [mode, setMode] = useState<'list' | 'add'>(initialMode === 'add' && canManage ? 'add' : 'list');
  // Открыли сразу на добавлении — после добавления и по «Отмена» окно закрывается целиком.
  const addOnly = initialMode === 'add';
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const name = (id: string) => usersById.get(id)?.displayName ?? 'Пользователь';

  const members = useMemo(
    () =>
      [...chat.memberIds].sort((a, b) => {
        if (a === currentUser.id) return -1;
        if (b === currentUser.id) return 1;
        return name(a).localeCompare(name(b), 'ru');
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chat.memberIds, usersById, currentUser.id],
  );

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...usersById.entries()]
      .filter(([id, u]) => !chat.memberIds.includes(id) && !(u as { dismissed?: boolean }).dismissed)
      .filter(([, u]) => !q || u.displayName.toLowerCase().includes(q))
      .sort(([, a], [, b]) => a.displayName.localeCompare(b.displayName, 'ru'));
  }, [usersById, chat.memberIds, query]);

  const add = async () => {
    if (selected.length === 0) return;
    setBusy('add');
    setError(null);
    try {
      await chatApi.addMembers(chat.id, selected);
      setSelected([]);
      onChanged();
      if (addOnly) onClose();
      else setMode('list');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить участников');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (userId: string) => {
    const isSelf = userId === currentUser.id;
    const msg = isSelf
      ? 'Выйти из чата? Он пропадёт из вашего списка, у остальных участников останется.'
      : `Исключить ${name(userId)} из чата?`;
    if (!confirm(msg)) return;
    setBusy(userId);
    setError(null);
    try {
      await chatApi.removeMember(chat.id, userId);
      if (isSelf) onLeft();
      else onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog flex max-h-[80vh] w-full max-w-md flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
          <div>
            <h2 className="text-base font-semibold text-ink">{mode === 'add' ? 'Добавить участников' : 'Участники чата'}</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              {mode === 'add'
                ? chat.kind === 'private'
                  ? 'Выберите одного или нескольких коллег. Личный чат станет групповым, история сохранится.'
                  : 'Выберите одного или нескольких коллег — они увидят всю историю переписки.'
                : `${chat.memberIds.length} ${plural(chat.memberIds.length)}`}
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-icon -mr-2 -mt-1 h-7 w-7" aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>

        {error && <p className="mx-6 mb-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

        {mode === 'list' ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
            {members.map((id) => {
              const isSelf = id === currentUser.id;
              const isCreator = chat.createdBy === id;
              return (
                <div key={id} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover">
                  <Avatar avatarUrl={usersById.get(id)?.avatarUrl ?? null} displayName={name(id)} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-sm text-ink">
                      {name(id)}
                      {isSelf && <span className="badge h-[18px] px-1.5">вы</span>}
                    </p>
                    {isCreator && (
                      <p className="flex items-center gap-1 text-2xs text-ink-faint">
                        <Crown size={10} /> создатель чата
                      </p>
                    )}
                  </div>
                  {!isSelf && canManage && (
                    <button
                      type="button"
                      onClick={() => void remove(id)}
                      disabled={busy !== null}
                      title="Исключить из чата"
                      className="btn-icon h-7 w-7 opacity-0 hover:text-danger focus:opacity-100 group-hover:opacity-100"
                    >
                      {busy === id ? <Loader2 size={14} className="animate-spin" /> : <UserMinus size={15} />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col px-6 pb-3">
            <div className="relative mb-2">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти коллегу" className="input pl-8" autoFocus />
            </div>
            <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
              {candidates.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-faint">{query ? 'Никого не найдено' : 'Все пользователи уже в чате'}</p>
              ) : (
                candidates.map(([id, u]) => {
                  const checked = selected.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setSelected((s) => (checked ? s.filter((x) => x !== id) : [...s, id]))}
                      className={clsx(
                        'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors',
                        checked ? 'bg-accent-soft/60' : 'hover:bg-surface-hover',
                      )}
                    >
                      <Avatar avatarUrl={u.avatarUrl} displayName={u.displayName} size="sm" />
                      <span className="flex-1 truncate text-ink">{u.displayName}</span>
                      <span
                        className={clsx(
                          'flex h-[18px] w-[18px] items-center justify-center rounded border',
                          checked ? 'border-accent bg-accent text-white' : 'border-line/25',
                        )}
                      >
                        {checked && <Check size={12} strokeWidth={3} />}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-line/[0.06] bg-surface-panel/60 px-6 py-3">
          {mode === 'list' ? (
            <>
              <button type="button" onClick={() => void remove(currentUser.id)} disabled={busy !== null} className="btn-ghost btn-sm -ml-2.5 hover:text-danger">
                <LogOut size={13} /> Выйти из чата
              </button>
              {canManage ? (
                <button type="button" onClick={() => setMode('add')} className="btn-primary btn-sm">
                  <UserPlus size={13} /> Добавить
                </button>
              ) : (
                <span className="text-right text-2xs text-ink-faint">Состав меняет создатель чата, администратор или тимлид</span>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  if (addOnly) {
                    onClose();
                    return;
                  }
                  setMode('list');
                  setSelected([]);
                }}
                className="btn-ghost btn-sm -ml-2.5"
              >
                {addOnly ? 'Отмена' : 'Назад'}
              </button>
              <button type="button" onClick={() => void add()} disabled={selected.length === 0 || busy !== null} className="btn-primary btn-sm">
                {busy === 'add' && <Loader2 size={12} className="animate-spin" />}
                Добавить{selected.length > 0 ? ` (${selected.length})` : ''}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function plural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'участник';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'участника';
  return 'участников';
}
