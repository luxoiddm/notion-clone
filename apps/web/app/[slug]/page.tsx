'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, FileText, Pencil } from 'lucide-react';
import { BlockListPreview } from '../../components/PageHistoryDialog';
import { PageIconDisplay } from '../../components/PageIconDisplay';
import { useSession } from '../../components/SessionProvider';
import { useTheme } from 'next-themes';
import { isCoverColor, resolveCoverColorHex, textColorForCover } from '../../lib/coverColors';
import type { PageBlock } from '../../lib/types';

interface PublicTreeItem {
  nodeId: string;
  parentId: string | null;
  ownerId: string;
  projectId: string;
  pageId: string;
  title: string;
  icon: string | null;
}

interface PublicSiteData {
  site: { slug: string; title: string; description: string };
  tree: PublicTreeItem[];
}

interface PublicPageContent {
  title: string;
  icon: string | null;
  coverImage: string | null;
  blocks: PageBlock[];
  /** True only if the current viewer is authenticated (same browser session as the main app) *and* has edit access to this specific page — an anonymous visitor, or a logged-in one without edit rights, both just get false, no error either way. */
  canEdit: boolean;
  ownerId: string;
  projectId: string;
  pageId: string;
}

export default function PublicSitePage() {
  const params = useParams<{ slug: string }>();
  // A logged-in visitor (same browser session as the main app) — not
  // required at all for viewing, only sent along so the backend can
  // decide whether to offer an edit link. See PublicPageContent.canEdit.
  const { accessToken } = useSession();
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';
  const [data, setData] = useState<PublicSiteData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [content, setContent] = useState<PublicPageContent | null>(null);

  useEffect(() => {
    setNotFound(false);
    setData(null);
    fetch(`/api/public/${params.slug}`)
      .then(async (res) => {
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const json = (await res.json()) as PublicSiteData;
        setData(json);
        setSelectedPageId(json.tree[0]?.pageId ?? null);
      })
      .catch(() => setNotFound(true));
  }, [params.slug]);

  useEffect(() => {
    if (!selectedPageId) {
      setContent(null);
      return;
    }
    setContent(null);
    fetch(`/api/public/${params.slug}/pages/${selectedPageId}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    })
      .then(async (res) => {
        if (res.ok) setContent((await res.json()) as PublicPageContent);
      })
      .catch(() => undefined);
  }, [selectedPageId, params.slug, accessToken]);

  if (notFound) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 text-ink-muted">
        <p className="text-lg font-medium text-ink">Страница не найдена</p>
        <p className="text-sm">Такого публичного адреса не существует, либо он сейчас выключен.</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-muted">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 shrink-0 border-r border-line/10 bg-surface-panel p-4">
        <h1 className="mb-1 text-sm font-semibold text-ink">{data.site.title}</h1>
        {data.site.description && <p className="mb-4 text-xs text-ink-muted">{data.site.description}</p>}
        {data.tree.length === 0 ? (
          <p className="text-xs text-ink-faint">Здесь пока ничего нет.</p>
        ) : (
          <PublicTreeNav tree={data.tree} selectedPageId={selectedPageId} onSelect={setSelectedPageId} />
        )}
      </aside>

      <main className="mx-auto min-w-0 max-w-3xl flex-1 px-8 py-10">
        {!selectedPageId ? (
          <p className="text-sm text-ink-faint">Здесь пока ничего нет — как только модератор одобрит первую страницу, она появится тут.</p>
        ) : !content ? (
          <div className="flex items-center gap-2 text-sm text-ink-muted">
            <Loader2 size={16} className="animate-spin" />
            Загрузка...
          </div>
        ) : (
          <article>
            {content.coverImage &&
              (() => {
                const coverIsColor = isCoverColor(content.coverImage);
                const textColor = coverIsColor ? textColorForCover(resolveCoverColorHex(content.coverImage, isDarkTheme)) : 'white';
                return (
                  <div className="relative -mx-8 -mt-10 mb-6 h-56 overflow-hidden sm:h-64">
                    <div
                      className="absolute inset-0"
                      style={
                        coverIsColor
                          ? { backgroundColor: resolveCoverColorHex(content.coverImage, isDarkTheme) }
                          : { backgroundImage: `url(${content.coverImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                      }
                    />
                    {!coverIsColor && <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />}
                    <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 px-8 pb-5">
                      {content.icon && <PageIconDisplay icon={content.icon} size={64} />}
                      <h1 className={`text-3xl font-bold ${textColor === 'white' ? 'text-white' : 'text-ink'}`}>{content.title || 'Untitled'}</h1>
                    </div>
                  </div>
                );
              })()}
            <div className="mb-6 flex items-start justify-between gap-4">
              {!content.coverImage && (
                <h1 className="flex items-center gap-2 text-3xl font-bold text-ink">
                  {content.icon && <PageIconDisplay icon={content.icon} size={32} />}
                  {content.title || 'Untitled'}
                </h1>
              )}
              {content.canEdit && (
                <a
                  href={`/?owner=${content.ownerId}&project=${content.projectId}&page=${content.pageId}`}
                  className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-line/10 px-2.5 py-1.5 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink"
                  title="Изменения потребуют повторного одобрения модератором"
                >
                  <Pencil size={13} />
                  Редактировать
                </a>
              )}
            </div>
            <BlockListPreview blocks={content.blocks} />
          </article>
        )}
      </main>
    </div>
  );
}

/** Builds the nested tree from the flat, parentId-based list the API returns — recomputed on every render, not cached, so it can never drift from `tree` itself. */
function PublicTreeNav({
  tree,
  selectedPageId,
  onSelect,
}: {
  tree: PublicTreeItem[];
  selectedPageId: string | null;
  onSelect: (pageId: string) => void;
}) {
  const renderLevel = (parentId: string | null, depth: number): React.ReactNode =>
    tree
      .filter((n) => n.parentId === parentId)
      .map((node) => (
        <div key={node.nodeId}>
          <button
            type="button"
            onClick={() => onSelect(node.pageId)}
            style={{ paddingLeft: 8 + depth * 14 }}
            className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm ${
              selectedPageId === node.pageId ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
            }`}
          >
            <PageIconDisplay icon={node.icon} size={14} fallback={<FileText size={13} className="text-ink-faint" />} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{node.title || 'Untitled'}</span>
          </button>
          {renderLevel(node.nodeId, depth + 1)}
        </div>
      ));

  return <nav className="space-y-0.5">{renderLevel(null, 0)}</nav>;
}
