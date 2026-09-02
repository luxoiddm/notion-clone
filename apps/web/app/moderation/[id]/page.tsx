'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Check, X, Trash2, ChevronUp, ChevronDown, Loader2, RefreshCw, Eye } from 'lucide-react';
import { moderationApi, type PublicSite, type EnrichedPublicNode } from '../../../lib/api';
import { useToast, ToastProvider } from '../../../components/Toast';
import { BlockListPreview } from '../../../components/PageHistoryDialog';
import type { PageBlock } from '../../../lib/types';

export default function ModerationSiteDetailPage() {
  return (
    <ToastProvider>
      <ModerationSiteDetail />
    </ToastProvider>
  );
}

function ModerationSiteDetail() {
  const params = useParams<{ id: string }>();
  const { push } = useToast();
  const [site, setSite] = useState<PublicSite | null>(null);
  const [nodes, setNodes] = useState<EnrichedPublicNode[] | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [previewNode, setPreviewNode] = useState<EnrichedPublicNode | null>(null);
  const [previewContent, setPreviewContent] = useState<{ title: string; icon: string | null; blocks: PageBlock[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const openPreview = (node: EnrichedPublicNode) => {
    if (node.pageMissing) return;
    setPreviewNode(node);
    setPreviewContent(null);
    setPreviewError(null);
    moderationApi
      .getNodeContent(params.id, node.id)
      .then(setPreviewContent)
      .catch((err) => setPreviewError(err instanceof Error ? err.message : 'Не удалось загрузить содержимое'));
  };

  const refresh = () =>
    moderationApi
      .getPublicSite(params.id)
      .then((r) => {
        setSite(r.site);
        setNodes(r.nodes);
      })
      .catch((err) => push(err instanceof Error ? err.message : 'Не удалось загрузить', 'error'));

  useEffect(() => {
    void refresh();
  }, [params.id]);

  // Refetches when the tab regains focus — the common case this catches
  // is leaving this page open, going elsewhere (another tab, the editor)
  // to act on something, then coming back here without a full reload.
  useEffect(() => {
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [params.id]);

  const approve = async (nodeId: string) => {
    try {
      await moderationApi.moderateNode(params.id, nodeId, { status: 'approved' });
      refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось одобрить', 'error');
    }
  };

  const reject = async (nodeId: string) => {
    try {
      await moderationApi.moderateNode(params.id, nodeId, { status: 'rejected', rejectionReason: rejectionReason || undefined });
      setRejectingId(null);
      setRejectionReason('');
      refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось отклонить', 'error');
    }
  };

  const removeNode = async (nodeId: string, label: string) => {
    if (!confirm(`Убрать «${label}» из этой публичной страницы? Дочерние узлы (если есть) поднимутся на верхний уровень дерева.`)) return;
    try {
      await moderationApi.deleteNode(params.id, nodeId);
      refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось удалить', 'error');
    }
  };

  const reparent = async (node: EnrichedPublicNode, newParentId: string | null) => {
    try {
      await moderationApi.moveNode(params.id, node.id, { parentId: newParentId, order: node.order });
      refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось переместить', 'error');
    }
  };

  const reorder = async (node: EnrichedPublicNode, siblings: EnrichedPublicNode[], direction: 'up' | 'down') => {
    const idx = siblings.findIndex((s) => s.id === node.id);
    const swapWith = direction === 'up' ? siblings[idx - 1] : siblings[idx + 1];
    if (!swapWith) return;
    try {
      // Swaps the two `order` values directly — simpler than
      // renumbering the whole sibling group, and sufficient since
      // `order` only ever needs to sort correctly relative to siblings,
      // not hold any particular absolute value.
      await Promise.all([
        moderationApi.moveNode(params.id, node.id, { parentId: node.parentId, order: swapWith.order }),
        moderationApi.moveNode(params.id, swapWith.id, { parentId: swapWith.parentId, order: node.order }),
      ]);
      refresh();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось изменить порядок', 'error');
    }
  };

  if (!site || !nodes) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const pending = nodes.filter((n) => n.status === 'pending').sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const approved = nodes.filter((n) => n.status === 'approved');

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-6 py-10 sm:px-10">
      <Link href="/moderation" className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft size={14} />
        Назад к модерации
      </Link>

      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-ink">{site.title}</h1>
        <button
          type="button"
          onClick={() => void refresh()}
          title="Обновить"
          className="flex items-center gap-1.5 rounded-md border border-line/10 px-2.5 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          <RefreshCw size={13} />
          Обновить
        </button>
      </div>
      <p className="mb-8 text-sm text-ink-muted">
        <a href={`/${site.slug}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
          /{site.slug}
        </a>
        {' · '}
        {site.enabled ? 'включена' : 'выключена'}
      </p>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-ink">Очередь модерации {pending.length > 0 && `(${pending.length})`}</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-ink-faint">Заявок на рассмотрении нет.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((node) => (
              <div key={node.id} className="rounded-lg border border-line/10 bg-surface-panel p-3">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => openPreview(node)}
                    disabled={node.pageMissing}
                    className="min-w-0 flex-1 text-left disabled:cursor-default"
                  >
                    <p className="flex items-center gap-1.5 truncate font-medium text-ink hover:underline">
                      {node.pageMissing ? <span className="text-ink-faint">(страница удалена)</span> : node.pageTitle || 'Untitled'}
                      {!node.pageMissing && <Eye size={13} className="shrink-0 text-ink-faint" />}
                    </p>
                    <p className="text-xs text-ink-faint">отправлено {new Date(node.submittedAt).toLocaleString('ru-RU')}</p>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void approve(node.id)}
                      disabled={node.pageMissing}
                      title="Одобрить"
                      className="rounded p-1.5 text-ink-muted hover:bg-green-500/15 hover:text-green-600 disabled:opacity-40"
                    >
                      <Check size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRejectingId(rejectingId === node.id ? null : node.id)}
                      title="Отклонить"
                      className="rounded p-1.5 text-ink-muted hover:bg-red-500/15 hover:text-red-500"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>

                {rejectingId === node.id && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      placeholder="Причина отклонения (необязательно)"
                      className="flex-1 rounded-md border border-line/10 bg-surface px-2 py-1 text-xs focus:border-accent focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void reject(node.id)}
                      className="shrink-0 rounded-md bg-red-500 px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                    >
                      Отклонить
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold text-ink">Дерево страницы</h2>
        <p className="mb-3 text-sm text-ink-muted">
          Структура здесь независима от того, как документ организован у автора в его личном пространстве — можно
          выстроить любую вложенность заново.
        </p>
        {approved.length === 0 ? (
          <p className="text-sm text-ink-faint">Ни одной одобренной страницы пока нет.</p>
        ) : (
          <PublicTree nodes={approved} onReparent={reparent} onReorder={reorder} onRemove={removeNode} onPreview={openPreview} />
        )}
      </section>

      {previewNode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setPreviewNode(null)}>
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-line/10 bg-surface-panel shadow-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-line/10 px-5 py-3">
              <h2 className="truncate text-sm font-semibold text-ink">
                {previewNode.pageTitle || 'Untitled'}
              </h2>
              <button
                type="button"
                onClick={() => setPreviewNode(null)}
                className="shrink-0 rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-ink"
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-[200px] flex-1 overflow-y-auto px-5 py-4">
              {previewError ? (
                <p className="text-sm text-red-500">{previewError}</p>
              ) : !previewContent ? (
                <div className="flex items-center gap-2 text-sm text-ink-muted">
                  <Loader2 size={16} className="animate-spin" />
                  Загрузка...
                </div>
              ) : (
                <BlockListPreview blocks={previewContent.blocks} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Builds and renders the approved-node tree from the flat parentId-based list — recomputed on every render from `nodes` directly, not cached separately, so it can never drift out of sync with the data driving it. */
function PublicTree({
  nodes,
  onReparent,
  onReorder,
  onRemove,
  onPreview,
}: {
  nodes: EnrichedPublicNode[];
  onReparent: (node: EnrichedPublicNode, newParentId: string | null) => void;
  onReorder: (node: EnrichedPublicNode, siblings: EnrichedPublicNode[], direction: 'up' | 'down') => void;
  onRemove: (nodeId: string, label: string) => void;
  onPreview: (node: EnrichedPublicNode) => void;
}) {
  const renderLevel = (parentId: string | null, depth: number): React.ReactNode => {
    const siblings = nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.order - b.order);
    return siblings.map((node) => (
      <div key={node.id}>
        <div className="flex items-center gap-2 border-b border-line/10 py-1.5" style={{ paddingLeft: depth * 20 }}>
          <button
            type="button"
            onClick={() => onPreview(node)}
            disabled={node.pageMissing}
            className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-sm text-ink hover:underline disabled:cursor-default disabled:no-underline"
          >
            {node.pageMissing ? <span className="text-ink-faint">(страница удалена)</span> : node.pageTitle || 'Untitled'}
            {!node.pageMissing && <Eye size={12} className="shrink-0 text-ink-faint" />}
          </button>

          <select
            value={node.parentId ?? ''}
            onChange={(e) => onReparent(node, e.target.value || null)}
            className="rounded-md border border-line/10 bg-surface px-1.5 py-1 text-xs text-ink-muted focus:border-accent focus:outline-none"
          >
            <option value="">— (корень)</option>
            {nodes
              .filter((n) => n.id !== node.id)
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.pageTitle || 'Untitled'}
                </option>
              ))}
          </select>

          <button type="button" onClick={() => onReorder(node, siblings, 'up')} className="rounded p-1 text-ink-faint hover:bg-surface-hover hover:text-ink">
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            onClick={() => onReorder(node, siblings, 'down')}
            className="rounded p-1 text-ink-faint hover:bg-surface-hover hover:text-ink"
          >
            <ChevronDown size={13} />
          </button>
          <button
            type="button"
            onClick={() => onRemove(node.id, node.pageTitle || 'Untitled')}
            title="Убрать из публичной страницы"
            className="rounded p-1 text-ink-faint hover:bg-surface-hover hover:text-red-500"
          >
            <Trash2 size={13} />
          </button>
        </div>
        {renderLevel(node.id, depth + 1)}
      </div>
    ));
  };

  return <div className="rounded-lg border border-line/10">{renderLevel(null, 0)}</div>;
}
