'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, FileText, Pencil } from 'lucide-react';
import { BlockListPreview } from '../../components/PageHistoryDialog';
import { PageIconDisplay } from '../../components/PageIconDisplay';
import { useSession } from '../../components/SessionProvider';
import { useTheme } from 'next-themes';
import { isCoverColor, resolveCoverColorHex, textColorForCover } from '../../lib/coverColors';
import { editorWidthStyle } from '../../lib/editorWidth';
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
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-2 bg-surface p-6 text-center text-ink-muted">
        <p className="text-5xl font-semibold tracking-tight text-ink-faint">404</p>
        <p className="mt-2 text-lg font-semibold text-ink">Страница не найдена</p>
        <p className="text-sm">Такого публичного адреса не существует, либо он сейчас выключен.</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-surface text-ink-faint">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-surface md:flex-row">
      <aside className="w-full shrink-0 border-b border-line/[0.07] bg-surface-panel px-3 py-4 md:sticky md:top-0 md:h-[100dvh] md:w-[260px] md:overflow-y-auto md:border-b-0 md:border-r">
        <div className="mb-4 flex items-center gap-2.5 px-1.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-accent to-accent/70 text-xs font-bold text-white shadow-xs">
            {data.site.title.trim().slice(0, 1).toUpperCase() || 'W'}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-ink">{data.site.title}</h1>
            {data.site.description && <p className="truncate text-2xs text-ink-faint">{data.site.description}</p>}
          </div>
        </div>
        {data.tree.length === 0 ? (
          <p className="text-xs text-ink-faint">Здесь пока ничего нет.</p>
        ) : (
          <PublicTreeNav tree={data.tree} selectedPageId={selectedPageId} onSelect={setSelectedPageId} />
        )}
      </aside>

      <main className="mx-auto w-full min-w-0 flex-1 px-6 py-10 sm:px-12 md:py-16" style={editorWidthStyle}>
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
                  <div className="relative mb-8 h-56 overflow-hidden rounded-xl sm:h-64">
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
                      <h1 className={`text-[34px] font-bold leading-tight tracking-[-0.025em] ${textColor === 'white' ? 'text-white' : 'text-ink'}`}>{content.title || 'Без названия'}</h1>
                    </div>
                  </div>
                );
              })()}
            <div className="mb-6 flex items-start justify-between gap-4">
              {!content.coverImage && (
                <h1 className="flex flex-col items-start gap-4 text-[38px] font-bold leading-[1.15] tracking-[-0.025em] text-ink sm:flex-row sm:items-center sm:gap-6">
                  {content.icon && <span className="flex h-[104px] w-[104px] shrink-0 items-center justify-center text-[68px] leading-none"><PageIconDisplay icon={content.icon} size={84} /></span>}
                  {content.title || 'Без названия'}
                </h1>
              )}
              {content.canEdit && (
                <a
                  href={`/?owner=${content.ownerId}&project=${content.projectId}&page=${content.pageId}`}
                  className="btn-secondary btn-sm ml-auto"
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
            style={{ paddingLeft: 8 + depth * 16 }}
            className={`flex h-[30px] w-full items-center gap-2 rounded-md pr-2 text-left text-sm transition-colors ${
              selectedPageId === node.pageId ? 'bg-surface-hover font-medium text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
            }`}
          >
            <PageIconDisplay icon={node.icon} size={14} fallback={<FileText size={13} className="text-ink-faint" />} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{node.title || 'Без названия'}</span>
          </button>
          {renderLevel(node.nodeId, depth + 1)}
        </div>
      ));

  return <nav className="space-y-px">{renderLevel(null, 0)}</nav>;
}
