'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X, Globe, Check, Loader2, ShieldCheck } from 'lucide-react';
import { publicSitesApi, type PublicSite } from '../lib/api';

/**
 * Отправка страницы на публикацию: в выбранный публичный раздел
 * (`/<slug>`, включённый или выключенный) или «без раздела» — в общую
 * очередь, откуда модератор сам распределит её. Страница появляется
 * там только после одобрения модератором (Admin / Team-Lead) — см.
 * /moderation. Доступно любому, у кого есть право редактирования
 * страницы (сервер проверяет это сам в POST /public-sites/:id/submit).
 *
 * Раньше эта секция жила внутри диалога «Поделиться» и показывалась
 * только при наличии публичных разделов, из-за чего её было легко не
 * заметить — теперь это отдельная кнопка «Опубликовать» в шапке документа.
 */
export function PublishDialog({
  ownerId,
  projectId,
  pageId,
  pageTitle,
  canManage,
  onClose,
}: {
  ownerId: string;
  projectId: string;
  pageId: string;
  pageTitle: string;
  /** Admin / Team-Lead — показываем ссылку на раздел модерации. */
  canManage: boolean;
  onClose: () => void;
}) {
  const [sites, setSites] = useState<PublicSite[] | null>(null);
  /** '' — «без раздела»: заявка уходит в общую очередь, модератор распределит её сам. */
  const [target, setTarget] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Все разделы, включая выключенные — подать можно в любой.
    publicSitesApi
      .list()
      .then(setSites)
      .catch(() => setSites([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      if (target) {
        await publicSitesApi.submit(target, { ownerId, projectId, pageId, parentId: null });
        setSentTo(sites?.find((s) => s.id === target)?.title ?? 'раздел');
      } else {
        await publicSitesApi.submitToInbox({ ownerId, projectId, pageId });
        setSentTo('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить на публикацию');
    } finally {
      setIsSubmitting(false);
    }
  };

  const Option = ({ value, title, subtitle, badge }: { value: string; title: string; subtitle: string; badge?: React.ReactNode }) => {
    const active = target === value;
    return (
      <button
        type="button"
        onClick={() => setTarget(value)}
        className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] ${
          active ? 'border-accent/60 bg-accent-soft/40 shadow-ring' : 'border-line/[0.08] bg-surface-raised hover:bg-surface-hover'
        }`}
      >
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${active ? 'border-accent' : 'border-line/25'}`}
        >
          {active && <span className="h-2 w-2 rounded-full bg-accent" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{title}</span>
            {badge}
          </span>
          <span className="block truncate text-xs text-ink-faint">{subtitle}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog w-full max-w-[480px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
              <Globe size={18} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-ink">Опубликовать страницу</h2>
              <p className="mt-0.5 text-xs text-ink-muted">
                «{pageTitle || 'Без названия'}» станет доступна без входа в систему после одобрения модератором.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-icon -mr-2 -mt-1 h-7 w-7" aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>

        {sentTo !== null ? (
          <div className="flex flex-col items-center px-6 pb-8 pt-2 text-center">
            <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-success/10 text-success">
              <Check size={20} strokeWidth={2.5} />
            </span>
            <p className="text-sm font-medium text-ink">Отправлено на модерацию</p>
            <p className="mt-1 max-w-xs text-sm text-ink-muted">
              {sentTo ? `Раздел «${sentTo}». ` : 'Модератор сам выберет подходящий раздел. '}
              Страница появится в публичном доступе после одобрения.
            </p>
          </div>
        ) : (
          <div className="px-6 pb-5">
            <p className="section-label mb-2 px-0">Куда опубликовать</p>
            {error && <p className="mb-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
            <div className="max-h-72 space-y-2 overflow-y-auto p-0.5">
              <Option value="" title="Без раздела" subtitle="Модератор сам распределит в нужный раздел" />
              {sites === null ? (
                <div className="flex items-center gap-2 px-1 py-3 text-xs text-ink-faint">
                  <Loader2 size={13} className="animate-spin" /> Загрузка разделов…
                </div>
              ) : (
                sites.map((site) => (
                  <Option
                    key={site.id}
                    value={site.id}
                    title={site.title}
                    subtitle={`/${site.slug}`}
                    badge={!site.enabled ? <span className="badge h-[18px] px-1.5">выключен</span> : undefined}
                  />
                ))
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-line/[0.06] bg-surface-panel/60 px-6 py-3">
          {canManage ? (
            <Link href="/moderation" className="btn-ghost btn-sm -ml-2.5">
              <ShieldCheck size={13} /> Очередь модерации
            </Link>
          ) : (
            <span />
          )}
          {sentTo !== null ? (
            <button type="button" onClick={onClose} className="btn-secondary btn-sm">
              Готово
            </button>
          ) : (
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="btn-ghost btn-sm">
                Отмена
              </button>
              <button type="button" onClick={() => void submit()} disabled={isSubmitting} className="btn-primary btn-sm">
                {isSubmitting && <Loader2 size={12} className="animate-spin" />}
                Отправить на модерацию
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
