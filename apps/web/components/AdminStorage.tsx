'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Check,
  Download,
  FileText,
  FolderInput,
  HardDrive,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
  UserX,
  X,
  ExternalLink,
} from 'lucide-react';
import { adminApi, fileDownloadUrl, storageAdminApi, type AdminFile, type AdminPage, type StorageUserRow } from '../lib/api';
import { Avatar } from './Avatar';
import { PageIconDisplay } from './PageIconDisplay';
import { FilePreviewDialog, formatFileSize } from './FilePreviewDialog';

type Notify = (message: string, kind?: 'success' | 'error') => void;

function bytes(n: number) {
  return n ? formatFileSize(n) : '0 Б';
}

function StatusBadge({ row }: { row: Pick<StorageUserRow, 'enabled' | 'dismissedAt'> }) {
  if (row.dismissedAt)
    return (
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 text-xs font-medium text-amber-700 dark:text-amber-300">
        <UserX size={12} /> Уволен
      </span>
    );
  return (
    <span
      className={clsx(
        'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',
        row.enabled ? 'bg-success/10 text-success' : 'bg-surface-sunken text-ink-faint',
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', row.enabled ? 'bg-success' : 'bg-ink-faint')} />
      {row.enabled ? 'Активен' : 'Отключён'}
    </span>
  );
}

function CopyPath({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(path).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      title="Скопировать путь (относительно STORAGE_ROOT)"
      className="group/copy inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-ink-muted hover:bg-surface-hover hover:text-ink"
    >
      <span className="truncate">{path}</span>
      {done ? <Check size={12} className="shrink-0 text-success" /> : <Copy size={12} className="shrink-0 opacity-0 group-hover/copy:opacity-100" />}
    </button>
  );
}

/**
 * Файловый менеджер в админке: таблица пользователей с занимаемым местом,
 * по клику — каталог пользователя (файлы и документы) со скачиванием,
 * удалением и переносом файлов. Здесь же — увольнение (папка уходит в
 * STORAGE_ROOT/dismissed/), возврат и полное удаление.
 */
export function AdminStorage({ currentUserId, onNotify }: { currentUserId: string; onNotify: Notify }) {
  const [rows, setRows] = useState<StorageUserRow[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'dismissed'>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    storageAdminApi
      .listUsers()
      .then(setRows)
      .catch((err) => onNotify(err instanceof Error ? err.message : 'Не удалось загрузить', 'error'));
  }, [onNotify]);

  useEffect(load, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter(
      (r) =>
        (filter === 'all' || (filter === 'dismissed' ? !!r.dismissedAt : !r.dismissedAt)) &&
        (!q || r.displayName.toLowerCase().includes(q) || (r.email ?? '').toLowerCase().includes(q) || r.id.includes(q)),
    );
  }, [rows, filter, query]);

  const total = (rows ?? []).reduce((s, r) => s + r.totalBytes, 0);
  const max = Math.max(1, ...(rows ?? []).map((r) => r.totalBytes));
  const dismissedCount = (rows ?? []).filter((r) => r.dismissedAt).length;
  const open = rows?.find((r) => r.id === openId) ?? null;

  if (open) {
    return (
      <UserCatalog
        row={open}
        users={rows ?? []}
        isSelf={open.id === currentUserId}
        onBack={() => setOpenId(null)}
        onChanged={load}
        onRemoved={() => {
          setOpenId(null);
          load();
        }}
        onNotify={onNotify}
      />
    );
  }

  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <p className="text-xs text-ink-muted">Занято всего</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{rows ? bytes(total) : '—'}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-ink-muted">Пользователей</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{rows ? rows.length - dismissedCount : '—'}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-ink-muted">Уволенных (папка dismissed/)</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{rows ? dismissedCount : '—'}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Имя, email или id папки" className="input pl-8" />
        </div>
        <div className="segmented">
          {(
            [
              ['all', 'Все'],
              ['active', 'Действующие'],
              ['dismissed', 'Уволенные'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setFilter(k)} className={clsx('segmented-item px-3', filter === k && 'segmented-item-active')}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-line/[0.06] text-left text-2xs font-semibold uppercase tracking-wider text-ink-faint">
              <th className="px-4 py-2.5">Пользователь</th>
              <th className="px-4 py-2.5">Статус</th>
              <th className="px-4 py-2.5 text-right">Файлы</th>
              <th className="px-4 py-2.5 text-right">Документы</th>
              <th className="w-[200px] px-4 py-2.5">Занято</th>
              <th className="px-4 py-2.5">Папка на диске</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line/[0.05]">
            {rows === null ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                  <Loader2 size={18} className="mx-auto animate-spin" />
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-ink-muted">
                  Никого не нашлось
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.id} onClick={() => setOpenId(r.id)} className="group cursor-pointer transition-colors hover:bg-surface-hover/60">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar avatarUrl={r.avatarUrl} displayName={r.displayName} size="sm" />
                      <div className="min-w-0">
                        <p className={clsx('truncate font-medium', r.dismissedAt ? 'text-ink-muted' : 'text-ink')}>{r.displayName}</p>
                        <p className="truncate text-xs text-ink-faint">{r.email ?? '—'}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge row={r} />
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink-muted">
                    {r.filesCount}
                    <span className="block text-2xs text-ink-faint">{bytes(r.filesBytes)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink-muted">{r.pagesCount}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, (r.totalBytes / max) * 100)}%` }} />
                      </div>
                      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-ink">{bytes(r.totalBytes)}</span>
                    </div>
                  </td>
                  <td className="max-w-[220px] px-3 py-2.5">
                    <CopyPath path={r.folder} />
                  </td>
                  <td className="pr-3">
                    <ChevronRight size={16} className="text-ink-faint group-hover:text-ink" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-faint">
        Соответствие папок и людей на сервере — в файле <span className="font-mono">STORAGE_ROOT/USERS.txt</span> (обновляется автоматически).
      </p>
    </section>
  );
}

function UserCatalog({
  row,
  users,
  isSelf,
  onBack,
  onChanged,
  onRemoved,
  onNotify,
}: {
  row: StorageUserRow;
  users: StorageUserRow[];
  isSelf: boolean;
  onBack: () => void;
  onChanged: () => void;
  onRemoved: () => void;
  onNotify: Notify;
}) {
  const [tab, setTab] = useState<'files' | 'pages'>('files');
  const [files, setFiles] = useState<AdminFile[] | null>(null);
  const [pages, setPages] = useState<AdminPage[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveTargets, setMoveTargets] = useState<AdminFile[] | null>(null);
  const [movePage, setMovePage] = useState<AdminPage | null>(null);
  const [preview, setPreview] = useState<AdminFile | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    storageAdminApi.listFiles(row.id).then(setFiles).catch(() => setFiles([]));
    storageAdminApi.listPages(row.id).then(setPages).catch(() => setPages([]));
    setSelected(new Set());
  }, [row.id]);
  useEffect(load, [load]);

  const refreshAll = () => {
    load();
    onChanged();
  };

  const deleteFiles = async (list: AdminFile[]) => {
    const used = list.filter((f) => f.usage.pages + f.usage.chats > 0);
    const msg =
      list.length === 1
        ? `Удалить «${list[0]!.originalName}»?`
        : `Удалить выбранные файлы (${list.length})?`;
    const warn = used.length ? `\n\nВнимание: ${used.length === 1 ? 'файл используется' : `${used.length} файла используются`} в документах или чатах — там он перестанет открываться.` : '';
    if (!confirm(msg + warn)) return;
    setBusy(true);
    try {
      for (const f of list) await storageAdminApi.deleteFile(row.id, f.fileName);
      onNotify(list.length === 1 ? 'Файл удалён' : `Удалено файлов: ${list.length}`, 'success');
      refreshAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось удалить', 'error');
    } finally {
      setBusy(false);
    }
  };

  const deletePage = async (p: AdminPage) => {
    if (!confirm(`Удалить документ «${p.title || 'Без названия'}» вместе с вложенными страницами? Это необратимо.`)) return;
    setBusy(true);
    try {
      await storageAdminApi.deletePage(row.id, p.projectId, p.id);
      onNotify('Документ удалён', 'success');
      refreshAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось удалить', 'error');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    if (
      !confirm(
        `Уволить «${row.displayName}»?\n\nВход будет запрещён, папка переедет в STORAGE_ROOT/dismissed/. Документы и файлы останутся доступны тем, кому были открыты; удалять их сможет только администратор.`,
      )
    )
      return;
    setBusy(true);
    try {
      await adminApi.dismissUser(row.id);
      onNotify('Пользователь уволен, папка перенесена в dismissed/', 'success');
      onChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось', 'error');
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      await adminApi.restoreUser(row.id);
      onNotify('Пользователь восстановлен', 'success');
      onChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось', 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeCompletely = async () => {
    const answer = prompt(
      `Удалить «${row.displayName}» полностью — со всеми документами и файлами (${bytes(row.totalBytes)})? Это необратимо: ссылки на его файлы и документы перестанут работать.\n\nДля подтверждения введите: УДАЛИТЬ`,
    );
    if (answer?.trim().toUpperCase() !== 'УДАЛИТЬ') return;
    setBusy(true);
    try {
      await adminApi.deleteUser(row.id);
      onNotify('Пользователь и его папка удалены', 'success');
      onRemoved();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось удалить', 'error');
      setBusy(false);
    }
  };

  const allChecked = !!files?.length && selected.size === files.length;
  const selectedFiles = (files ?? []).filter((f) => selected.has(f.fileName));

  return (
    <section className="space-y-4">
      <button type="button" onClick={onBack} className="-ml-1 flex items-center gap-0.5 rounded-md px-1 py-1 text-sm text-ink-muted hover:text-ink">
        <ChevronLeft size={16} /> Все пользователи
      </button>

      <div className="card flex flex-wrap items-center gap-4 p-4">
        <Avatar avatarUrl={row.avatarUrl} displayName={row.displayName} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold text-ink">{row.displayName}</p>
            <StatusBadge row={row} />
          </div>
          <p className="text-xs text-ink-muted">
            {row.email ?? '—'} · {bytes(row.totalBytes)}
            {row.dismissedAt && ` · уволен ${new Date(row.dismissedAt).toLocaleDateString('ru-RU')}`}
          </p>
          <div className="-ml-1.5 mt-0.5 flex items-center gap-1 text-xs text-ink-faint">
            <HardDrive size={12} className="ml-1.5" /> <CopyPath path={row.folder} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {row.dismissedAt ? (
            <button type="button" onClick={() => void restore()} disabled={busy} className="btn-secondary btn-sm">
              <RotateCcw size={14} /> Вернуть
            </button>
          ) : (
            <button type="button" onClick={() => void dismiss()} disabled={busy || isSelf} className="btn-secondary btn-sm" title={isSelf ? 'Нельзя уволить самого себя' : undefined}>
              <UserX size={14} /> Уволить
            </button>
          )}
          <button type="button" onClick={() => void removeCompletely()} disabled={busy || isSelf} className="btn-ghost btn-sm text-danger hover:bg-danger/10">
            <Trash2 size={14} /> Удалить полностью
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-line/[0.07]">
        <div className="flex gap-1">
          {(
            [
              ['files', 'Файлы', files?.length],
              ['pages', 'Документы', pages?.length],
            ] as const
          ).map(([k, label, n]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={clsx(
                '-mb-px flex items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors',
                tab === k ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {label}
              {n !== undefined && <span className="badge h-[18px] px-1.5">{n}</span>}
            </button>
          ))}
        </div>
        {tab === 'files' && selected.size > 0 && (
          <div className="flex items-center gap-2 pb-2 text-sm">
            <span className="text-ink-muted">Выбрано: {selected.size}</span>
            <button type="button" onClick={() => setMoveTargets(selectedFiles)} disabled={busy} className="btn-secondary btn-sm">
              <FolderInput size={14} /> Перенести
            </button>
            <button type="button" onClick={() => void deleteFiles(selectedFiles)} disabled={busy} className="btn-ghost btn-sm text-danger hover:bg-danger/10">
              <Trash2 size={14} /> Удалить
            </button>
          </div>
        )}
      </div>

      {tab === 'files' ? (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line/[0.06] text-left text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                <th className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Выбрать все"
                    checked={allChecked}
                    onChange={() => setSelected(allChecked ? new Set() : new Set((files ?? []).map((f) => f.fileName)))}
                    className="h-4 w-4 accent-[rgb(var(--accent))]"
                  />
                </th>
                <th className="px-2 py-2.5">Файл</th>
                <th className="px-4 py-2.5 text-right">Размер</th>
                <th className="px-4 py-2.5">Загружен</th>
                <th className="px-4 py-2.5">Используется</th>
                <th className="w-[130px]" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/[0.05]">
              {files === null ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-ink-faint">
                    <Loader2 size={18} className="mx-auto animate-spin" />
                  </td>
                </tr>
              ) : files.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-sm text-ink-muted">
                    Файлов нет
                  </td>
                </tr>
              ) : (
                files.map((f) => {
                  const checked = selected.has(f.fileName);
                  const usage = [f.usage.pages && `${f.usage.pages} док.`, f.usage.chats && `${f.usage.chats} чат`].filter(Boolean).join(', ');
                  return (
                    <tr key={f.fileName} className={clsx('group transition-colors', checked ? 'bg-accent-soft/40' : 'hover:bg-surface-hover/60')}>
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Выбрать ${f.originalName}`}
                          checked={checked}
                          onChange={() =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(f.fileName)) next.delete(f.fileName);
                              else next.add(f.fileName);
                              return next;
                            })
                          }
                          className="h-4 w-4 accent-[rgb(var(--accent))]"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <button type="button" onClick={() => setPreview(f)} className="flex min-w-0 items-center gap-2.5 text-left">
                          {f.mimeType.startsWith('image/') ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={f.url} alt="" loading="lazy" className="h-8 w-8 shrink-0 rounded object-cover" />
                          ) : (
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-surface-sunken text-ink-faint">
                              <FileText size={15} />
                            </span>
                          )}
                          <span className="min-w-0">
                            <span className="block max-w-[280px] truncate font-medium text-ink hover:underline">{f.originalName}</span>
                            <span className="block truncate font-mono text-2xs text-ink-faint">files/{f.fileName}</span>
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{bytes(f.size)}</td>
                      <td className="px-4 py-2 tabular-nums text-ink-muted">{new Date(f.uploadedAt).toLocaleDateString('ru-RU')}</td>
                      <td className="px-4 py-2 text-xs">{usage ? <span className="text-ink">{usage}</span> : <span className="text-ink-faint">нигде</span>}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-0.5 opacity-70 group-hover:opacity-100">
                          <a href={fileDownloadUrl(f.url)} download={f.originalName} title="Скачать" className="btn-icon">
                            <Download size={14} />
                          </a>
                          <button type="button" onClick={() => setMoveTargets([f])} disabled={busy} title="Перенести другому пользователю" className="btn-icon">
                            <FolderInput size={14} />
                          </button>
                          <button type="button" onClick={() => void deleteFiles([f])} disabled={busy} title="Удалить" className="btn-icon hover:text-danger">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line/[0.06] text-left text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                <th className="px-4 py-2.5">Документ</th>
                <th className="px-4 py-2.5">Изменён</th>
                <th className="px-4 py-2.5 text-right">Размер</th>
                <th className="w-[130px]" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/[0.05]">
              {pages === null ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-ink-faint">
                    <Loader2 size={18} className="mx-auto animate-spin" />
                  </td>
                </tr>
              ) : pages.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-sm text-ink-muted">
                    Документов нет
                  </td>
                </tr>
              ) : (
                pages.map((p) => (
                  <tr key={p.id} className="group hover:bg-surface-hover/60">
                    <td className="px-4 py-2" style={{ paddingLeft: 16 + p.path.length * 20 }}>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center text-[18px] leading-none">
                          <PageIconDisplay icon={p.icon} size={22} fallback={<FileText size={15} className="text-ink-faint" />} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink">{p.title || 'Без названия'}</span>
                          <span className="block truncate text-2xs text-ink-faint">{[p.projectName, ...p.path].join(' / ')}</span>
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2 tabular-nums text-ink-muted">{new Date(p.updatedAt).toLocaleDateString('ru-RU')}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{bytes(p.bytes)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-0.5 opacity-70 group-hover:opacity-100">
                        <Link href={`/?owner=${row.id}&project=${p.projectId}&page=${p.id}`} title="Открыть" className="btn-icon">
                          <ExternalLink size={14} />
                        </Link>
                        <button type="button" onClick={() => setMovePage(p)} disabled={busy} title="Передать другому пользователю" className="btn-icon">
                          <FolderInput size={14} />
                        </button>
                        <button type="button" onClick={() => void deletePage(p)} disabled={busy} title="Удалить документ" className="btn-icon hover:text-danger">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {moveTargets && (
        <MoveDialog
          files={moveTargets}
          fromUserId={row.id}
          users={users}
          onClose={() => setMoveTargets(null)}
          onDone={(n, toName) => {
            setMoveTargets(null);
            onNotify(n === 1 ? `Файл перенесён: ${toName}` : `Перенесено файлов: ${n} → ${toName}`, 'success');
            refreshAll();
          }}
          onError={(m) => onNotify(m, 'error')}
        />
      )}

      {movePage && (
        <MovePageDialog
          page={movePage}
          fromUserId={row.id}
          users={users}
          onClose={() => setMovePage(null)}
          onDone={(msg) => {
            setMovePage(null);
            onNotify(msg, 'success');
            refreshAll();
          }}
          onError={(m) => onNotify(m, 'error')}
        />
      )}

      {preview && (
        <FilePreviewDialog
          file={{ url: preview.url, name: preview.originalName, mimeType: preview.mimeType, size: preview.size }}
          onClose={() => setPreview(null)}
          onDelete={() => {
            const f = preview;
            setPreview(null);
            void deleteFiles([f]);
          }}
        />
      )}
    </section>
  );
}

function MoveDialog({
  files,
  fromUserId,
  users,
  onClose,
  onDone,
  onError,
}: {
  files: AdminFile[];
  fromUserId: string;
  users: StorageUserRow[];
  onClose: () => void;
  onDone: (count: number, toName: string) => void;
  onError: (message: string) => void;
}) {
  const options = users.filter((u) => u.id !== fromUserId && !u.dismissedAt).sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
  const [to, setTo] = useState(options[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const usedCount = files.filter((f) => f.usage.pages + f.usage.chats > 0).length;

  const submit = async () => {
    if (!to) return;
    setBusy(true);
    try {
      for (const f of files) await storageAdminApi.moveFile(fromUserId, f.fileName, to);
      onDone(files.length, options.find((u) => u.id === to)?.displayName ?? '');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Не удалось перенести');
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog w-full max-w-[440px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
          <div>
            <h2 className="text-base font-semibold text-ink">Перенести {files.length === 1 ? 'файл' : `файлы (${files.length})`}</h2>
            <p className="mt-0.5 truncate text-xs text-ink-muted">{files.length === 1 ? files[0]!.originalName : 'в каталог другого пользователя'}</p>
          </div>
          <button type="button" onClick={onClose} className="btn-icon -mr-2 -mt-1" aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 px-6">
          <label className="label" htmlFor="move-to">
            Кому
          </label>
          <select id="move-to" value={to} onChange={(e) => setTo(e.target.value)} className="input">
            {options.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
                {u.email ? ` — ${u.email}` : ''}
              </option>
            ))}
          </select>
          <p className="text-xs leading-relaxed text-ink-muted">
            {usedCount > 0
              ? `Ссылки на ${usedCount === 1 ? 'файл' : 'файлы'} в документах и чатах обновятся автоматически; публичные ссылки продолжат работать.`
              : 'Публичные ссылки на файлы продолжат работать.'}
          </p>
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-line/[0.06] bg-surface-panel/60 px-6 py-3">
          <button type="button" onClick={onClose} className="btn-secondary btn-sm">
            Отмена
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy || !to} className="btn-primary btn-sm">
            {busy && <Loader2 size={13} className="animate-spin" />}
            Перенести
          </button>
        </div>
      </div>
    </div>
  );
}

function MovePageDialog({
  page,
  fromUserId,
  users,
  onClose,
  onDone,
  onError,
}: {
  page: AdminPage;
  fromUserId: string;
  users: StorageUserRow[];
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const options = users.filter((u) => u.id !== fromUserId && !u.dismissedAt).sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
  const [to, setTo] = useState(options[0]?.id ?? '');
  const [withFiles, setWithFiles] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!to) return;
    setBusy(true);
    try {
      const r = await storageAdminApi.movePage(fromUserId, page.projectId, page.id, to, withFiles);
      const who = options.find((u) => u.id === to)?.displayName ?? '';
      onDone(
        `Передано ${who}: документов — ${r.movedPages}` + (r.movedFiles ? `, файлов — ${r.movedFiles}` : ''),
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Не удалось передать документ');
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog w-full max-w-[460px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">Передать документ</h2>
            <p className="mt-0.5 truncate text-xs text-ink-muted">
              {page.title || 'Без названия'}
              {page.children > 0 && ` и вложенные страницы (${page.children})`}
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-icon -mr-2 -mt-1" aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 px-6">
          <label className="label" htmlFor="move-page-to">
            Кому
          </label>
          <select id="move-page-to" value={to} onChange={(e) => setTo(e.target.value)} className="input">
            {options.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
                {u.email ? ` — ${u.email}` : ''}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line/[0.08] bg-surface-panel px-3 py-2.5">
            <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" />
            <span className="text-sm text-ink">
              Вместе с картинками и файлами владельца, вставленными в документ
              <span className="block text-xs text-ink-muted">Иначе они останутся в каталоге прежнего владельца.</span>
            </span>
          </label>
          <p className="text-xs leading-relaxed text-ink-muted">
            Документ окажется в корне дерева нового владельца. Ссылки на него в других документах, чатах и публикациях обновятся
            автоматически, общий доступ сохранится.
          </p>
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-line/[0.06] bg-surface-panel/60 px-6 py-3">
          <button type="button" onClick={onClose} className="btn-secondary btn-sm">
            Отмена
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy || !to} className="btn-primary btn-sm">
            {busy && <Loader2 size={13} className="animate-spin" />}
            Передать
          </button>
        </div>
      </div>
    </div>
  );
}
