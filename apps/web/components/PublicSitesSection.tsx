'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, ExternalLink, Loader2, ChevronRight } from 'lucide-react';
import { moderationApi, type PublicSite } from '../lib/api';
import { useToast } from './Toast';

export function PublicSitesSection() {
  const router = useRouter();
  const { push } = useToast();
  const [sites, setSites] = useState<PublicSite[] | null>(null);
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const refresh = () => moderationApi.listPublicSites().then(setSites).catch((err) => push(err.message, 'error'));

  useEffect(() => {
    void refresh();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreating(true);
    try {
      await moderationApi.createPublicSite({ slug, title });
      setSlug('');
      setTitle('');
      refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось создать публичную страницу', 'error');
    } finally {
      setIsCreating(false);
    }
  };

  const toggleEnabled = async (site: PublicSite) => {
    try {
      await moderationApi.updatePublicSite(site.id, { enabled: !site.enabled });
      refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось обновить', 'error');
    }
  };

  const handleDelete = async (site: PublicSite) => {
    if (!confirm(`Удалить публичную страницу «${site.title}» (/${site.slug})? Все заявки на модерацию и дерево страниц удалятся вместе с ней. Это необратимо.`)) {
      return;
    }
    try {
      await moderationApi.deletePublicSite(site.id);
      refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось удалить', 'error');
    }
  };

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-ink">Публичные разделы</h2>
      <p className="mb-4 max-w-2xl text-sm text-ink-muted">
        Курируемые деревья документов, доступные без входа в систему по адресу <code>/&lt;название&gt;</code>. Любой
        пользователь может предложить свою страницу для публикации — появляется здесь в очереди на модерацию.
      </p>

      <form onSubmit={handleCreate} className="card mb-6 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[160px] flex-1">
          <label className="label">Адрес (slug)</label>
          <input
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="doc"
            pattern="[-a-z0-9]+"
            title="Только строчные латинские буквы, цифры и дефис"
            className="input"
          />
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="label">Название</label>
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="input"
          />
        </div>
        <button
          type="submit"
          disabled={isCreating}
          className="btn-primary h-9"
        >
          {isCreating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Создать
        </button>
      </form>

      {sites === null ? (
        <div className="skeleton h-32 animate-shimmer rounded-xl" />
      ) : sites.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line/[0.12] px-6 py-12 text-center text-sm text-ink-muted">Публичных страниц пока нет — создайте первую формой выше.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line/[0.06] bg-surface-panel text-2xs uppercase tracking-[0.06em] text-ink-faint">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Название</th>
                <th className="px-4 py-2.5 font-semibold">Адрес</th>
                <th className="px-4 py-2.5 font-semibold">Статус</th>
                <th className="px-4 py-2.5 font-semibold text-right">Действия</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <tr
                  key={site.id}
                  onClick={() => router.push(`/moderation/${site.id}`)}
                  className="cursor-pointer border-t border-line/[0.06] transition-colors first:border-t-0 hover:bg-surface-hover/60"
                >
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1 font-medium text-ink">
                      {site.title}
                      <ChevronRight size={14} className="text-ink-faint" />
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={`/${site.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1 text-ink-muted hover:text-ink"
                    >
                      /{site.slug}
                      <ExternalLink size={12} />
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleEnabled(site);
                      }}
                      className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ${
                        site.enabled ? 'bg-success/10 text-success' : 'bg-surface-sunken text-ink-faint'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${site.enabled ? 'bg-success' : 'bg-ink-faint'}`} />
                      {site.enabled ? 'Опубликована' : 'Выключена'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDelete(site);
                      }}
                      title="Удалить"
                      className="btn-icon h-7 w-7 hover:text-danger"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
