'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { Lock, Plus, Search, SquareCheckBig, X } from 'lucide-react';
import { useSession } from '../SessionProvider';
import { tasksApi, type Task, type TaskProject } from '../../lib/api';
import { STATUS_META, blockersOf, projectColor, taskKey, upsertTask, useTasks } from '../../lib/tasks';
import { BlockedChip, DateIssueChip, DeadlineChip, DueChip, PeopleStack, StatusChip } from './TaskBits';
import { NewTaskDialog, type NewTaskPrefill } from './TaskDialogs';

/** content блока «Задача» — `${projectId}:${taskId}`. */
export function parseTaskBlock(content: string): { projectId: string; taskId: string } | null {
  const [projectId, taskId] = content.split(':');
  return projectId && taskId ? { projectId, taskId } : null;
}

/**
 * Живая карточка задачи внутри документа (блок `/Задача`): статус,
 * исполнители, сроки обновляются сами. Кто не участник проекта — видит
 * только название, сохранённое при вставке.
 */
export function TaskBlockCard({ content, snapshotTitle }: { content: string; snapshotTitle?: string }) {
  const { accessToken, user } = useSession();
  const data = useTasks(user ? accessToken : null);
  const ref = parseTaskBlock(content);
  const fromStore = ref ? data.tasks.find((t) => t.id === ref.taskId) : undefined;
  const [fetched, setFetched] = useState<{ task: Task; project: TaskProject } | 'denied' | null>(null);

  useEffect(() => {
    if (!ref || !user || fromStore || !data.loaded) return;
    let cancelled = false;
    tasksApi
      .get(ref.projectId, ref.taskId)
      .then((r) => !cancelled && setFetched({ task: r.task, project: r.project }))
      .catch(() => !cancelled && setFetched('denied'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, user?.id, !!fromStore, data.loaded]);

  const task = fromStore ?? (fetched && fetched !== 'denied' ? fetched.task : undefined);
  const project = task ? data.projects.find((p) => p.id === task.projectId) ?? (fetched && fetched !== 'denied' ? fetched.project : undefined) : undefined;
  const byId = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);

  if (!task || !project) {
    return (
      <span className="my-1 flex items-center gap-2.5 rounded-xl border border-line/[0.1] bg-surface-raised px-3.5 py-3 text-[14px] text-ink-muted">
        {fetched === 'denied' || !user ? <Lock size={15} /> : <SquareCheckBig size={15} />}
        <span className="truncate">{snapshotTitle || 'Задача'}</span>
        {(fetched === 'denied' || !user) && <span className="ml-auto shrink-0 text-xs">нет доступа</span>}
      </span>
    );
  }
  const done = task.status === 'done';
  return (
    <Link
      href={`/tasks?project=${project.id}&task=${task.id}`}
      contentEditable={false}
      style={{ textDecoration: 'none' }}
      className="my-1 flex flex-col gap-2 rounded-xl border border-line/[0.1] bg-surface-raised px-3.5 py-3 text-ink no-underline shadow-xs transition hover:border-accent/40 [&_*]:!no-underline"
    >
      <span className="flex items-center gap-2 text-xs text-ink-muted">
        <span className="h-2 w-2 rounded-[3px]" style={{ background: projectColor(project) }} />
        {project.name} · {taskKey(project, task)}
        <span className="ml-auto">
          <StatusChip status={task.status} />
        </span>
      </span>
      <span className={clsx('flex items-center gap-2 text-[15px] font-semibold text-ink', done && 'text-ink-faint line-through')}>
        <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', STATUS_META[task.status].dot)} />
        {task.title}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <DueChip task={task} today={data.today} />
        <DeadlineChip task={task} today={data.today} />
        <BlockedChip blockers={blockersOf(task, byId)} project={project} />
        <DateIssueChip task={task} byId={byId} project={project} />
        <span className="ml-auto">
          <PeopleStack ids={[task.assigneeId, ...task.coAssigneeIds]} people={data.people} />
        </span>
      </span>
    </Link>
  );
}

/** Выбор задачи для блока `/Задача`: найти существующую или создать новую (она получит ссылку на документ). */
export function TaskPickerDialog({
  pageRef,
  onClose,
  onPick,
}: {
  pageRef?: NewTaskPrefill['pageRefs'];
  onClose: () => void;
  onPick: (task: Task, project: TaskProject) => void;
}) {
  const { accessToken, user } = useSession();
  const data = useTasks(accessToken);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const projectMap = useMemo(() => new Map(data.projects.map((p) => [p.id, p])), [data.projects]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!user) return null;
  if (creating || (data.loaded && !data.projects.length)) {
    return (
      <NewTaskDialog
        projects={data.projects}
        people={data.people}
        meId={user.id}
        prefill={{ title: q, pageRefs: pageRef }}
        onClose={() => (data.projects.length ? setCreating(false) : onClose())}
        onCreated={(t, p) => {
          upsertTask(t);
          onPick(t, p);
        }}
      />
    );
  }

  const needle = q.trim().toLowerCase();
  const list = data.tasks
    .filter((t) => !needle || t.title.toLowerCase().includes(needle) || taskKey(projectMap.get(t.projectId), t).toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 50);

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Вставить задачу" className="dialog flex max-h-[80dvh] max-w-lg flex-col">
        <div className="flex items-center gap-2 border-b border-line/[0.06] px-4 py-3">
          <Search size={15} className="text-ink-faint" />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти задачу или ввести название новой" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
          <button type="button" onClick={onClose} className="btn-icon" aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>
        <button type="button" onClick={() => setCreating(true)} className="menu-item mx-2 mt-2 h-11 text-accent">
          <Plus size={16} />
          {q.trim() ? `Создать задачу «${q.trim()}»` : 'Создать новую задачу'}
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.map((t) => {
            const p = projectMap.get(t.projectId);
            return (
              <button key={t.id} type="button" onClick={() => p && onPick(t, p)} className="menu-item h-auto min-h-[44px] py-2">
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATUS_META[t.status].dot)} />
                <span className="shrink-0 text-xs text-ink-muted">{taskKey(p, t)}</span>
                <span className="truncate">{t.title}</span>
              </button>
            );
          })}
          {data.loaded && !list.length && <p className="px-2 py-4 text-sm text-ink-faint">Ничего не нашлось</p>}
        </div>
      </div>
    </div>
  );
}
