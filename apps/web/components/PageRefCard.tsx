'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Lock } from 'lucide-react';
import { api } from '../lib/api';
import { useUserStore } from '../store/useUserStore';
import { PageIconDisplay } from './PageIconDisplay';

export function PageRefCard({ ownerId, projectId, pageId }: { ownerId: string; projectId: string; pageId: string }) {
  const [state, setState] = useState<{ title: string; icon: string | null } | 'loading' | 'denied'>('loading');
  const { openPage } = useUserStore();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api
      .getPage(ownerId, projectId, pageId)
      .then(({ meta }) => {
        if (!cancelled) setState({ title: meta.title || 'Untitled', icon: meta.icon });
      })
      .catch(() => {
        if (!cancelled) setState('denied');
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, projectId, pageId]);

  if (state === 'denied') {
    return (
      <div className="mt-1 flex items-center gap-2 rounded-md border border-line/10 bg-surface px-2.5 py-1.5 text-xs text-ink-faint">
        <Lock size={12} />
        Нет доступа к документу
      </div>
    );
  }

  if (state === 'loading') {
    return <div className="skeleton animate-shimmer mt-1 h-8 w-40 rounded-md" />;
  }

  return (
    <button
      type="button"
      onClick={() => {
        openPage(ownerId, projectId, pageId);
        router.push('/');
      }}
      className="mt-1 flex max-w-full items-center gap-2 rounded-md border border-line/10 bg-surface px-2.5 py-1.5 text-left text-xs hover:bg-surface-hover"
    >
      <PageIconDisplay icon={state.icon} size={13} fallback={<FileText size={13} className="text-ink-faint" />} className="shrink-0" />
      <span className="truncate font-medium text-ink">{state.title}</span>
    </button>
  );
}
