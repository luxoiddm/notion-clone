'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, KeyRound, Mail, Pencil, Check, X, ShieldCheck, Users, Palette, Search, UserPlus, HardDrive, UserX, RotateCcw } from 'lucide-react';
import { AdminStorage } from '../../components/AdminStorage';
import { useSession } from '../../components/SessionProvider';
import { adminApi, type AdminUser } from '../../lib/api';
import { useToast, ToastProvider } from '../../components/Toast';
import { SiteSettingsForm } from '../../components/SiteSettingsForm';
import { AppShell, FullScreenLoader, SignInRequired } from '../../components/AppShell';
import { Avatar } from '../../components/Avatar';

const ROLES: AdminUser['role'][] = ['Admin', 'Team-Lead', 'Member', 'Guest'];

/**
 * Stays open until the admin explicitly closes it — a one-time secret
 * (temp password, invite link) shown in a toast disappears on its own
 * timer regardless of whether anyone actually managed to copy it in
 * time, which is exactly the complaint this replaces.
 */
function CredentialModal({ title, label, value, onClose }: { title: string; label: string; value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, non-HTTPS context, etc.)
      // — the value is still right there selectable in the <code> box,
      // so this isn't a dead end, just quietly falls back to manual
      // copy instead of surfacing a scary error for a non-critical action.
    }
  };

  return (
    // Deliberately no onClick={onClose} on the backdrop, unlike every
    // other dialog in this app — an accidental click outside shouldn't
    // dismiss a credential before the admin has actually copied it. The
    // explicit "Закрыть" button is the only way out.
    <div className="dialog-overlay">
      <div className="dialog w-full max-w-sm p-6">
        <h2 className="mb-1 text-base font-semibold text-ink">{title}</h2>
        <p className="mb-3 text-xs text-ink-muted">Сохраните сейчас — это окно больше не появится.</p>

        <label className="label">{label}</label>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-line/10 bg-surface-sunken px-3 py-2 font-mono text-[13px] text-ink">
            {value}
          </code>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="btn-secondary btn-sm h-9"
          >
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="btn-primary mt-5 w-full"
        >
          Закрыть
        </button>
      </div>
    </div>
  );
}

export default function AdminPage() {
  return (
    <ToastProvider>
      <AdminPanel />
    </ToastProvider>
  );
}

function AdminPanel() {
  const { user, isLoading: sessionLoading } = useSession();
  const { push } = useToast();

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credentialModal, setCredentialModal] = useState<{ title: string; label: string; value: string } | null>(null);
  const [tab, setTab] = useState<'users' | 'storage' | 'site'>('users');
  const [panel, setPanel] = useState<'create' | 'invite' | null>(null);
  const [query, setQuery] = useState('');

  const refresh = () => adminApi.listUsers().then(setUsers).catch((err) => setError(err.message));
  const notify = useCallback((message: string, kind?: 'success' | 'error') => push(message, kind), [push]);

  useEffect(() => {
    if (user?.role === 'Admin') refresh();
  }, [user]);

  if (sessionLoading) {
    return <FullScreenLoader />;
  }

  if (!user) {
    return <SignInRequired />;
  }

  if (user.role !== 'Admin') {
    return <SignInRequired message="Раздел доступен только администраторам." />;
  }

  const q = query.trim().toLowerCase();
  const filtered = (users ?? []).filter(
    (u) => !q || u.displayName.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q),
  );
  const stats = [
    { label: 'Всего пользователей', value: users?.length ?? '—' },
    { label: 'Активны', value: users ? users.filter((u) => u.enabled).length : '—' },
    { label: 'Администраторы', value: users ? users.filter((u) => u.role === 'Admin').length : '—' },
  ];

  return (
    <AppShell
      mobileBack={{ href: '/more', label: 'Ещё' }}
      title="Администрирование"
      icon={<ShieldCheck size={19} />}
      description="Пользователи, приглашения и брендинг рабочего пространства."
      width="wide"
    >
      <div className="mb-6 flex gap-1 border-b border-line/[0.07]">
        {(
          [
            ['users', 'Пользователи', Users],
            ['storage', 'Файлы', HardDrive],
            ['site', 'Настройки сайта', Palette],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors ${
              tab === key ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'site' ? (
        <SiteSettingsForm />
      ) : tab === 'storage' ? (
        <AdminStorage currentUserId={user.id} onNotify={notify} />
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            {stats.map((st) => (
              <div key={st.label} className="card px-4 py-3.5">
                <p className="text-xs text-ink-muted">{st.label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums tracking-[-0.02em] text-ink">{st.value}</p>
              </div>
            ))}
          </div>

          {error && <p className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-xs">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по имени или email" className="input pl-8" />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPanel(panel === 'invite' ? null : 'invite')} className={`btn-secondary ${panel === 'invite' ? 'bg-surface-hover' : ''}`}>
                <Mail size={15} />
                Пригласить
              </button>
              <button type="button" onClick={() => setPanel(panel === 'create' ? null : 'create')} className="btn-primary">
                <UserPlus size={15} />
                Добавить
              </button>
            </div>
          </div>

          {panel === 'create' && (
            <CreateUserForm
              onCreated={(tempPassword, email) => {
                setCredentialModal({ title: 'Пользователь создан', label: `Пароль для ${email}`, value: tempPassword });
                setPanel(null);
                refresh();
              }}
              onError={(msg) => push(msg, 'error')}
            />
          )}

          {panel === 'invite' && (
            <InviteForm
              onSent={(url) => {
                setCredentialModal({ title: 'Приглашение создано', label: 'Ссылка-приглашение', value: url });
                setPanel(null);
              }}
              onError={(msg) => push(msg, 'error')}
            />
          )}

          <div className="card overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-line/[0.06] bg-surface-panel text-2xs uppercase tracking-[0.06em] text-ink-faint">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Пользователь</th>
                  <th className="px-4 py-2.5 font-semibold">Роль</th>
                  <th className="px-4 py-2.5 font-semibold">Статус</th>
                  <th className="px-4 py-2.5 font-semibold">Создан</th>
                  <th className="px-4 py-2.5 text-right font-semibold">
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/[0.06]">
                {users === null ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-ink-faint">
                      <Loader2 size={18} className="mx-auto animate-spin" />
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-ink-muted">
                      {users.length === 0 ? 'Пользователей пока нет.' : `Ничего не найдено по «${query}»`}
                    </td>
                  </tr>
                ) : (
                  filtered.map((u) => (
                    <UserRow
                      key={u.id}
                      target={u}
                      isSelf={u.id === user.id}
                      onChanged={refresh}
                      onNotify={(msg, kind) => push(msg, kind)}
                      onShowCredential={(title, label, value) => setCredentialModal({ title, label, value })}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {credentialModal && <CredentialModal {...credentialModal} onClose={() => setCredentialModal(null)} />}
    </AppShell>
  );
}

const ROLE_LABEL: Record<AdminUser['role'], string> = {
  Admin: 'Администратор',
  'Team-Lead': 'Тимлид',
  Member: 'Участник',
  Guest: 'Гость',
};

const ROLE_BADGE: Record<AdminUser['role'], string> = {
  Admin: 'badge-accent',
  'Team-Lead': 'badge border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300',
  Member: 'badge',
  Guest: 'badge',
};

function CreateUserForm({ onCreated, onError }: { onCreated: (tempPassword: string, email: string) => void; onError: (msg: string) => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AdminUser['role']>('Member');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const { temporaryPassword } = await adminApi.createUser({ email, displayName, role, password: password || undefined });
      onCreated(temporaryPassword, email);
      setEmail('');
      setDisplayName('');
      setPassword('');
      setRole('Member');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Не удалось создать пользователя');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card mb-4 flex animate-fadeIn flex-wrap items-end gap-3 p-4">
      <div className="min-w-[160px] flex-1">
        <label className="label">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
        />
      </div>
      <div className="min-w-[160px] flex-1">
        <label className="label">Имя</label>
        <input
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="input"
        />
      </div>
      <div className="min-w-[160px] flex-1">
        <label className="label">Пароль (необязательно)</label>
        <input
          type="text"
          placeholder="Пусто — сгенерировать автоматически"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={password ? 8 : undefined}
          title="Минимум 8 символов, если задаёте вручную"
          className="input"
        />
      </div>
      <div>
        <label className="label">Роль</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as AdminUser['role'])}
          className="input w-auto"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="btn-primary h-9"
      >
        {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        Создать
      </button>
    </form>
  );
}

function InviteForm({ onSent, onError }: { onSent: (url: string) => void; onError: (msg: string) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AdminUser['role']>('Member');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const { inviteUrl } = await adminApi.invite({ email, role });
      onSent(inviteUrl);
      setEmail('');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Не удалось создать приглашение');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card mb-4 flex animate-fadeIn flex-wrap items-end gap-3 p-4">
      <div className="min-w-[160px] flex-1">
        <label className="label">Email для приглашения</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
        />
      </div>
      <div>
        <label className="label">Роль</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as AdminUser['role'])}
          className="input w-auto"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="btn-primary h-9"
      >
        {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
        Создать ссылку
      </button>
    </form>
  );
}

function UserRow({
  target,
  isSelf,
  onChanged,
  onNotify,
  onShowCredential,
}: {
  target: AdminUser;
  isSelf: boolean;
  onChanged: () => void;
  onNotify: (msg: string, kind: 'success' | 'error' | 'info') => void;
  onShowCredential: (title: string, label: string, value: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [displayName, setDisplayName] = useState(target.displayName);
  const [role, setRole] = useState(target.role);
  const [isBusy, setIsBusy] = useState(false);

  const save = async () => {
    setIsBusy(true);
    try {
      await adminApi.updateUser(target.id, { displayName, role });
      onNotify('Пользователь обновлён', 'success');
      setIsEditing(false);
      onChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось обновить', 'error');
    } finally {
      setIsBusy(false);
    }
  };

  const resetPassword = async () => {
    setIsBusy(true);
    try {
      const { temporaryPassword } = await adminApi.resetPassword(target.id);
      onShowCredential('Пароль сброшен', target.email ? `Новый пароль для ${target.email}` : 'Новый пароль', temporaryPassword);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось сбросить пароль', 'error');
    } finally {
      setIsBusy(false);
    }
  };

  const dismiss = async () => {
    if (
      !confirm(
        `Уволить «${target.displayName}»?\n\nВход будет запрещён, папка переедет в STORAGE_ROOT/dismissed/. Документы и файлы останутся доступны тем, кому были открыты; удалять их сможет только администратор (вкладка «Файлы»).`,
      )
    )
      return;
    setIsBusy(true);
    try {
      await adminApi.dismissUser(target.id);
      onNotify('Пользователь уволен', 'success');
      onChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось', 'error');
    } finally {
      setIsBusy(false);
    }
  };

  const restore = async () => {
    setIsBusy(true);
    try {
      await adminApi.restoreUser(target.id);
      onNotify('Пользователь восстановлен', 'success');
      onChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось', 'error');
    } finally {
      setIsBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Удалить пользователя «${target.displayName}» полностью — со всеми документами и файлами? Это необратимо. Чтобы сохранить документы, лучше «Уволить».`)) return;
    setIsBusy(true);
    try {
      await adminApi.deleteUser(target.id);
      onNotify('Пользователь удалён', 'success');
      onChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось удалить', 'error');
    } finally {
      setIsBusy(false);
    }
  };

  const toggleEnabled = async () => {
    setIsBusy(true);
    try {
      await adminApi.updateUser(target.id, { enabled: !target.enabled });
      onChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось обновить', 'error');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <tr className="group transition-colors hover:bg-surface-hover/60">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Avatar avatarUrl={null} displayName={target.displayName} size="sm" />
          <div className="min-w-0">
            {isEditing ? (
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input h-8" autoFocus />
            ) : (
              <p className="flex items-center gap-1.5 truncate font-medium text-ink">
                {target.displayName}
                {isSelf && <span className="badge h-[18px] px-1.5">вы</span>}
              </p>
            )}
            <p className="truncate text-xs text-ink-faint">{target.email ?? '—'}</p>
          </div>
        </div>
      </td>
      <td className="px-4 py-2.5">
        {isEditing ? (
          <select value={role} onChange={(e) => setRole(e.target.value as AdminUser['role'])} className="input h-8 w-auto">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        ) : (
          <span className={ROLE_BADGE[target.role]}>{ROLE_LABEL[target.role]}</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {target.dismissedAt ? (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 text-xs font-medium text-amber-700 dark:text-amber-300">
            <UserX size={12} /> Уволен
          </span>
        ) : (
        <button
          type="button"
          onClick={() => void toggleEnabled()}
          disabled={isBusy || (isSelf && target.enabled)}
          title={isSelf && target.enabled ? 'Нельзя отключить самого себя' : undefined}
          className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:hover:opacity-100 ${
            target.enabled ? 'bg-success/10 text-success' : 'bg-surface-sunken text-ink-faint'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${target.enabled ? 'bg-success' : 'bg-ink-faint'}`} />
          {target.enabled ? 'Активен' : 'Отключён'}
        </button>
        )}
      </td>
      <td className="px-4 py-2.5 tabular-nums text-ink-muted">
        {new Date(target.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center justify-end gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          {isEditing ? (
            <>
              <button type="button" onClick={save} disabled={isBusy} className="btn-icon text-success">
                <Check size={14} />
              </button>
              <button type="button" onClick={() => setIsEditing(false)} disabled={isBusy} className="btn-icon">
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setIsEditing(true)} disabled={isBusy} title="Изменить" className="btn-icon">
                <Pencil size={14} />
              </button>
              <button type="button" onClick={resetPassword} disabled={isBusy} title="Сбросить пароль" className="btn-icon">
                <KeyRound size={14} />
              </button>
              {target.dismissedAt ? (
                <button type="button" onClick={() => void restore()} disabled={isBusy} title="Вернуть (папка обратно в users/)" className="btn-icon">
                  <RotateCcw size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void dismiss()}
                  disabled={isBusy || isSelf}
                  title={isSelf ? 'Нельзя уволить самого себя' : 'Уволить (папка → dismissed/, документы сохраняются)'}
                  className="btn-icon disabled:opacity-30"
                >
                  <UserX size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={remove}
                disabled={isBusy || isSelf}
                title={isSelf ? 'Нельзя удалить самого себя' : 'Удалить полностью'}
                className="btn-icon hover:text-danger disabled:opacity-30"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
