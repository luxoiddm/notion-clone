'use client';

import { useCallback, useEffect, useState } from 'react';
import { Inbox, Eye, X, Loader2, Check, FileText } from 'lucide-react';
import { api, moderationApi, type EnrichedInboxItem, type PublicSite } from '../lib/api';
import type { PageBlock } from '../lib/types';
import { useToast } from './Toast';
import { PageIconDisplay } from './PageIconDisplay';
import { BlockListPreview } from './PageHistoryDialog';

/**
 * Заявки на публикацию «без раздела» — автор не выбрал раздел, модератор
 * распределяет страницу сам: выбирает раздел и публикует (страница сразу
 * попадает в дерево раздела одобренной), либо отклоняет заявку.
 */
export function PublicInboxSection({ onAssigned }: { onAssigned?: () => void }) {
  const { push } = useToast();
  const [items, setItems] = useState<EnrichedInboxItem[] | null>(null);
  const [sites, setSites] = useState<PublicSite[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ item: EnrichedInboxItem; blocks: PageBlock[] | null; error: string | null } | null>(null);

  const refresh = useCallback(() => {
    moderationApi
      .listInbox()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    refresh();
    moderationApi.listPublicSites().then(setSites).catch(() => setSites([]));
    api
      .listUsersDirectory()
      .then((users) => setNames(new Map(users.map((u) => [u.id, u.displayName]))))
      .catch(() => undefined);
  }, [refresh]);

  const assign = async (item: EnrichedInboxItem) => {
    const siteId = targets[item.id] ?? sites[0]?.id;
    if (!siteId) return;
    setBusyId(item.id);
    try {
      await moderationApi.assignInboxItem(item.id, siteId);
      push(`Опубликовано в «${sites.find((s) => s.id === siteId)?.title ?? 'раздел'}»`, 'success');
      refresh();
      onAssigned?.();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось опубликовать', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (item: EnrichedInboxItem) => {
    if (!confirm(`Отклонить заявку «${item.pageTitle || 'Без названия'}»?`)) return;
    setBusyId(item.id);
    try {
      await moderationApi.deleteInboxItem(item.id);
      refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось отклонить', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const openPreview = (item: EnrichedInboxItem) => {
    setPreview({ item, blocks: null, error: null });
    moderationApi
      .getInboxContent(item.id)
      .then((c) => setPreview({ item, blocks: c.blocks, error: null }))
      .catch((err) => setPreview({ item, blocks: null, error: err instanceof Error ? err.message : 'Не удалось загрузить' }));
  };

  return (
    <section className="mb-10">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
        <Inbox size={15} className="text-ink-faint" />
        Заявки без раздела
        {items && items.length > 0 && <span className="badge-accent">{items.length}</span>}
      </h2>
      <p className="mb-3 text-sm text-ink-muted">Авторы не выбрали раздел — выберите его сами и опубликуйте, или отклоните заявку.</p>

      {items === null ? (
        <div className="skeleton h-16 animate-shimmer rounded-xl" />
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line/[0.12] px-6 py-6 text-center text-sm text-ink-muted">Новых заявок нет.</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="card flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => openPreview(item)}
                disabled={item.pageMissing}
                className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
                title="Просмотреть страницу"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-lg">
                  <PageIconDisplay icon={item.pageIcon} size={20} fallback={<FileText size={16} className="text-ink-faint" />} />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
                    {item.pageMissing ? <span className="text-ink-faint">(страница удалена)</span> : item.pageTitle || 'Без названия'}
                    {!item.pageMissing && <Eye size={13} className="shrink-0 text-ink-faint" />}
                  </span>
                  <span className="block truncate text-xs text-ink-faint">
                    {names.get(item.submittedBy) ?? 'Автор'} · {new Date(item.submittedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
              </button>

              <div className="flex shrink-0 items-center gap-2">
                {sites.length === 0 ? (
                  <span className="text-xs text-ink-faint">Сначала создайте раздел</span>
                ) : (
                  <>
                    <select
                      value={targets[item.id] ?? sites[0]!.id}
                      onChange={(e) => setTargets((t) => ({ ...t, [item.id]: e.target.value }))}
                      className="input h-8 w-auto max-w-[200px] text-xs"
                      disabled={item.pageMissing}
                    >
                      {sites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                          {!s.enabled ? ' (выключен)' : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void assign(item)}
                      disabled={busyId === item.id || item.pageMissing}
                      className="btn-primary btn-sm h-8"
                    >
                      {busyId === item.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                      Опубликовать
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void reject(item)}
                  disabled={busyId === item.id}
                  title="Отклонить заявку"
                  className="btn-icon h-8 w-8 hover:text-danger"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <div className="dialog-overlay" onClick={() => setPreview(null)}>
          <div className="dialog flex max-h-[85vh] w-full max-w-2xl flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex shrink-0 items-center justify-between border-b border-line/[0.07] px-5 py-3">
              <h2 className="truncate text-sm font-semibold text-ink">{preview.item.pageTitle || 'Без названия'}</h2>
              <button type="button" onClick={() => setPreview(null)} className="btn-icon h-7 w-7">
                <X size={16} />
              </button>
            </div>
            <div className="min-h-[200px] flex-1 overflow-y-auto px-5 py-4">
              {preview.error ? (
                <p className="text-sm text-danger">{preview.error}</p>
              ) : !preview.blocks ? (
                <div className="flex items-center gap-2 text-sm text-ink-muted">
                  <Loader2 size={16} className="animate-spin" /> Загрузка…
                </div>
              ) : (
                <BlockListPreview blocks={preview.blocks} />
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
