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
      <h2 className="mb-1 text-lg font-semibold text-ink">Публичные страницы</h2>
      <p className="mb-3 text-sm text-ink-muted">
        Курируемые деревья документов, доступные без входа в систему по адресу <code>/&lt;название&gt;</code>. Любой
        пользователь может предложить свою страницу для публикации — появляется здесь в очереди на модерацию.
      </p>

      <form onSubmit={handleCreate} className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-line/10 bg-surface-panel p-4">
        <div className="min-w-[160px] flex-1">
          <label className="mb-1 block text-xs text-ink-muted">Адрес (slug)</label>
          <input
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="doc"
            pattern="[-a-z0-9]+"
            title="Только строчные латинские буквы, цифры и дефис"
            className="w-full rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          />
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block text-xs text-ink-muted">Название</label>
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-line/10 bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={isCreating}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {isCreating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Создать
        </button>
      </form>

      {sites === null ? (
        <p className="text-sm text-ink-muted">Загрузка...</p>
      ) : sites.length === 0 ? (
        <p className="text-sm text-ink-faint">Публичных страниц пока нет.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-panel text-xs uppercase text-ink-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Название</th>
                <th className="px-4 py-2 font-medium">Адрес</th>
                <th className="px-4 py-2 font-medium">Статус</th>
                <th className="px-4 py-2 font-medium text-right">Действия</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <tr
                  key={site.id}
                  onClick={() => router.push(`/moderation/${site.id}`)}
                  className="cursor-pointer border-t border-line/10 hover:bg-surface-hover"
                >
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-1 font-medium text-ink">
                      {site.title}
                      <ChevronRight size={14} className="text-ink-faint" />
                    </span>
                  </td>
                  <td className="px-4 py-2">
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
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleEnabled(site);
                      }}
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        site.enabled ? 'bg-green-500/15 text-green-600' : 'bg-surface-hover text-ink-faint'
                      }`}
                    >
                      {site.enabled ? 'Включена' : 'Выключена'}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDelete(site);
                      }}
                      title="Удалить"
                      className="rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-red-500"
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
