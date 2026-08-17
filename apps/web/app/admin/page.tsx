'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Plus, Trash2, KeyRound, Mail, Pencil, Check, X } from 'lucide-react';
import { useSession } from '../../components/SessionProvider';
import { adminApi, type AdminUser } from '../../lib/api';
import { useToast, ToastProvider } from '../../components/Toast';
import { SiteSettingsForm } from '../../components/SiteSettingsForm';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-sm rounded-xl border border-line/10 bg-surface-panel p-5 shadow-panel">
        <h2 className="mb-1 text-sm font-semibold text-ink">{title}</h2>
        <p className="mb-3 text-xs text-ink-muted">Сохраните сейчас — это окно больше не появится.</p>

        <label className="mb-1 block text-xs text-ink-muted">{label}</label>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm text-ink">
            {value}
          </code>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="shrink-0 rounded-md border border-line/10 px-2.5 py-1.5 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-md bg-accent py-2 text-sm font-medium text-white hover:opacity-90"
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

  const refresh = () => adminApi.listUsers().then(setUsers).catch((err) => setError(err.message));

  useEffect(() => {
    if (user?.role === 'Admin') refresh();
  }, [user]);

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

  if (user.role !== 'Admin') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-ink-muted">
        <p>Раздел доступен только администраторам.</p>
        <Link href="/" className="text-accent hover:underline">
          На главную
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-4xl px-6 py-10 sm:px-10">
      <Link href="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft size={14} />
        Назад в рабочее пространство
      </Link>

      <h1 className="mb-1 text-2xl font-bold text-ink">Админ-панель</h1>
      <p className="mb-6 text-sm text-ink-muted">Создание, редактирование и удаление пользователей.</p>

      <SiteSettingsForm />

      {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

      <CreateUserForm
        onCreated={(tempPassword, email) => {
          setCredentialModal({ title: 'Пользователь создан', label: `Пароль для ${email}`, value: tempPassword });
          refresh();
        }}
        onError={(msg) => push(msg, 'error')}
      />

      <InviteForm
        onSent={(url) => setCredentialModal({ title: 'Приглашение отправлено', label: 'Ссылка-приглашение', value: url })}
        onError={(msg) => push(msg, 'error')}
      />

      <div className="mt-8 overflow-x-auto rounded-lg border border-line/10">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-surface-panel text-xs uppercase text-ink-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Имя</th>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Роль</th>
              <th className="px-4 py-2 font-medium">Создан</th>
              <th className="px-4 py-2 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody>
            {users === null ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink-muted">
                  Загрузка...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink-muted">
                  Пользователей пока нет.
                </td>
              </tr>
            ) : (
              users.map((u) => (
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

      {credentialModal && <CredentialModal {...credentialModal} onClose={() => setCredentialModal(null)} />}
    </div>
  );
}

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
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2 rounded-lg border border-line/10 bg-surface-panel p-4">
      <div className="min-w-[160px] flex-1">
        <label className="mb-1 block text-xs text-ink-muted">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
        />
      </div>
      <div className="min-w-[160px] flex-1">
        <label className="mb-1 block text-xs text-ink-muted">Имя</label>
        <input
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
        />
      </div>
      <div className="min-w-[160px] flex-1">
        <label className="mb-1 block text-xs text-ink-muted">Пароль (необязательно)</label>
        <input
          type="text"
          placeholder="Пусто — сгенерировать автоматически"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={password ? 8 : undefined}
          title="Минимум 8 символов, если задаёте вручную"
          className="w-full rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-ink-muted">Роль</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as AdminUser['role'])}
          className="rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-60"
      >
        {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        Создать пользователя
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
    <form onSubmit={handleSubmit} className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-line/20 p-4">
      <div className="min-w-[160px] flex-1">
        <label className="mb-1 block text-xs text-ink-muted">Email для приглашения</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-ink-muted">Роль</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as AdminUser['role'])}
          className="rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="flex items-center gap-1.5 rounded-md border border-line/10 px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-60"
      >
        {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
        Отправить приглашение
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

  const remove = async () => {
    if (!confirm(`Удалить пользователя «${target.displayName}»? Это удалит все его страницы безвозвратно.`)) return;
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

  return (
    <tr className="border-t border-line/10">
      <td className="px-4 py-2">
        {isEditing ? (
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="w-full rounded border border-line/10 bg-surface px-1.5 py-1 text-sm" />
        ) : (
          target.displayName
        )}
      </td>
      <td className="px-4 py-2 text-ink-muted">{target.email ?? '—'}</td>
      <td className="px-4 py-2">
        {isEditing ? (
          <select value={role} onChange={(e) => setRole(e.target.value as AdminUser['role'])} className="rounded border border-line/10 bg-surface px-1.5 py-1 text-sm">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          target.role
        )}
      </td>
      <td className="px-4 py-2 text-ink-muted">{new Date(target.createdAt).toLocaleDateString('ru-RU')}</td>
      <td className="px-4 py-2">
        <div className="flex items-center justify-end gap-1">
          {isEditing ? (
            <>
              <button type="button" onClick={save} disabled={isBusy} className="rounded p-1.5 text-emerald-600 hover:bg-surface-hover">
                <Check size={14} />
              </button>
              <button type="button" onClick={() => setIsEditing(false)} disabled={isBusy} className="rounded p-1.5 text-ink-muted hover:bg-surface-hover">
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setIsEditing(true)} disabled={isBusy} title="Изменить" className="rounded p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink">
                <Pencil size={14} />
              </button>
              <button type="button" onClick={resetPassword} disabled={isBusy} title="Сбросить пароль" className="rounded p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink">
                <KeyRound size={14} />
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={isBusy || isSelf}
                title={isSelf ? 'Нельзя удалить самого себя' : 'Удалить'}
                className="rounded p-1.5 text-ink-muted hover:bg-surface-hover hover:text-red-500 disabled:opacity-30"
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
