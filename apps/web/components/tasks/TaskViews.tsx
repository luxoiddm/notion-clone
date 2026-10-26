'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Flag, Link2, Plus } from 'lucide-react';
import { tasksApi, type Task, type TaskProject } from '../../lib/api';
import {
  BOARD_COLUMNS,
  MONTH_NAMES,
  STATUS_META,
  WEEKDAYS,
  actionItems,
  addDays,
  blockersOf,
  dateIssues,
  describeDateIssue,
  diffDays,
  fmtDate,
  isOpen,
  plural,
  projectColor,
  taskKey,
  upsertTask,
  weekday,
  worstLevel,
  type Person,
} from '../../lib/tasks';
import { Avatar } from '../Avatar';
import { BlockedChip, DateIssueChip, DeadlineChip, DueChip, PeopleStack, ProjectTag, StatusChip } from './TaskBits';

export interface ViewProps {
  tasks: Task[];
  allTasks: Task[];
  projects: Map<string, TaskProject>;
  people: Map<string, Person>;
  meId: string;
  today: string;
  onOpen: (t: Task) => void;
  onCreate: (prefill?: { dueDate?: string | null; status?: Task['status']; projectId?: string | null }) => void;
  onError: (msg: string) => void;
}

function useById(allTasks: Task[]) {
  return useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
}

// ------------------------------------------------------------------ строка задачи (списки)

function TaskRow({ t, p, props, extra }: { t: Task; p?: TaskProject; props: ViewProps; extra?: React.ReactNode }) {
  const byId = useById(props.allTasks);
  const blockers = blockersOf(t, byId);
  const done = t.status === 'done';
  const canTick = t.assigneeId === props.meId || t.authorId === props.meId;
  const tick = async () => {
    try {
      if (done) upsertTask(await tasksApi.action(t.projectId, t.id, 'reopen'));
      else upsertTask(await tasksApi.action(t.projectId, t.id, 'submit'));
    } catch (err) {
      props.onError(err instanceof Error ? err.message : 'Не получилось');
    }
  };
  return (
    <div className="flex min-h-[60px] items-center gap-3 border-b border-line/[0.05] px-3 py-2 last:border-b-0 hover:bg-surface-hover/60 md:px-4">
      <button
        type="button"
        onClick={() => canTick && void tick()}
        disabled={!canTick || t.status === 'review'}
        title={t.status === 'review' ? 'На проверке у постановщика' : done ? 'Открыть снова' : t.authorId === props.meId ? 'Готово' : 'Сдать на проверку'}
        aria-label={done ? `Открыть снова: ${t.title}` : `Готово: ${t.title}`}
        className={clsx(
          'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border-[1.8px] transition-colors',
          done ? 'border-[#16A34A] bg-[#16A34A] text-white' : t.status === 'review' ? 'border-[#D97706] bg-[#FEF3C7] dark:bg-[#4A3612]' : 'border-line/30 hover:border-accent',
        )}
      >
        {done && <CheckCircle2 size={14} />}
      </button>
      <button type="button" onClick={() => props.onOpen(t)} className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
        <span className={clsx('max-w-full truncate text-[14.5px] font-medium', done && 'text-ink-faint line-through')}>{t.title}</span>
        <span className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs text-ink-faint">{taskKey(p, t)}</span>
          <ProjectTag project={p} />
          <DueChip task={t} today={props.today} />
          <DeadlineChip task={t} today={props.today} />
          <BlockedChip blockers={blockers} project={p} />
          <DateIssueChip task={t} byId={byId} project={p} />
          {t.status === 'review' && <StatusChip status="review" />}
          {extra}
        </span>
      </button>
      <PeopleStack ids={[t.assigneeId, ...t.coAssigneeIds]} people={props.people} />
    </div>
  );
}

// ------------------------------------------------------------------ «Мои задачи» (A + поручения из C)

export function MyTasksView(props: ViewProps & { projectsList: TaskProject[] }) {
  const { tasks, meId, today, projects, people } = props;
  const [tab, setTab] = useState<'mine' | 'control'>('mine');
  const [role, setRole] = useState<'all' | 'resp' | 'co'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const { toAccept, toReview } = actionItems(tasks, meId, today);

  const respond = async (t: Task, action: 'accept' | 'decline' | 'approve') => {
    if (action === 'decline') return props.onOpen(t);
    setBusy(t.id);
    try {
      upsertTask(await tasksApi.action(t.projectId, t.id, action));
    } catch (err) {
      props.onError(err instanceof Error ? err.message : 'Не получилось');
    } finally {
      setBusy(null);
    }
  };

  const mine = tasks.filter(
    (t) =>
      isOpen(t) &&
      t.acceptance !== 'pending' &&
      (role === 'all' ? t.assigneeId === meId || t.coAssigneeIds.includes(meId) || (t.authorId === meId && !t.assigneeId) : role === 'resp' ? t.assigneeId === meId : t.coAssigneeIds.includes(meId)),
  );
  const groups: { title: string; tone: string; items: Task[] }[] = [
    { title: 'Просрочено', tone: 'text-danger', items: mine.filter((t) => t.dueDate && t.dueDate < today) },
    { title: 'Сегодня', tone: 'text-accent-ink', items: mine.filter((t) => t.dueDate === today) },
    { title: 'На этой неделе', tone: 'text-ink-muted', items: mine.filter((t) => t.dueDate && t.dueDate > today && diffDays(t.dueDate, today) <= 6 - weekday(today) + 7 * 0) },
    { title: 'Позже', tone: 'text-ink-muted', items: mine.filter((t) => t.dueDate && diffDays(t.dueDate, today) > 6 - weekday(today)) },
    { title: 'Без срока', tone: 'text-ink-muted', items: mine.filter((t) => !t.dueDate) },
  ];
  for (const g of groups) g.items.sort((a, b) => (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'));
  const recentDone = tasks
    .filter((t) => t.status === 'done' && (t.assigneeId === meId || t.coAssigneeIds.includes(meId)) && t.completedAt && Date.now() - Date.parse(t.completedAt) < 7 * 86_400_000)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));

  const control = tasks.filter((t) => t.authorId === meId && t.assigneeId && t.assigneeId !== meId);
  const controlGroups: { title: string; tone: string; items: Task[] }[] = [
    { title: 'Ждут моей проверки', tone: 'text-[#92400E] dark:text-[#FCD58A]', items: control.filter((t) => t.status === 'review') },
    { title: 'Отклонены', tone: 'text-danger', items: control.filter((t) => t.acceptance === 'declined' && isOpen(t)) },
    { title: 'Просрочены у исполнителей', tone: 'text-danger', items: control.filter((t) => isOpen(t) && t.status !== 'review' && t.dueDate && t.dueDate < today) },
    { title: 'Ещё не приняты', tone: 'text-ink-muted', items: control.filter((t) => t.acceptance === 'pending' && isOpen(t)) },
    { title: 'В работе, в срок', tone: 'text-ink-muted', items: control.filter((t) => isOpen(t) && t.status !== 'review' && t.acceptance === 'accepted' && !(t.dueDate && t.dueDate < today)) },
  ];
  // Каждая задача — только в первой подходящей группе (на проверке важнее, чем «не принята»).
  {
    const seen = new Set<string>();
    for (const g of controlGroups) {
      g.items = g.items.filter((t) => !seen.has(t.id));
      g.items.forEach((t) => seen.add(t.id));
    }
  }

  const seg = (on: boolean) => clsx('h-9 flex-1 rounded-lg px-3 text-[13px] font-medium md:flex-none', on ? 'bg-surface-raised text-ink shadow-xs' : 'text-ink-muted');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex w-full gap-0.5 rounded-xl bg-surface-hover p-1 md:w-auto" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'mine'} className={seg(tab === 'mine')} onClick={() => setTab('mine')}>
            Мне
          </button>
          <button type="button" role="tab" aria-selected={tab === 'control'} className={seg(tab === 'control')} onClick={() => setTab('control')}>
            Я поручил(а){toReview.length ? ` · ${toReview.length}` : ''}
          </button>
        </div>
        {tab === 'mine' && (
          <div className="flex gap-1">
            {(
              [
                ['all', 'Все'],
                ['resp', 'Отвечаю'],
                ['co', 'Помогаю'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setRole(id)} className={clsx('h-8 rounded-full px-3 text-[13px]', role === id ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-muted hover:bg-surface-hover')}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'mine' && toAccept.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="section-label px-1 text-accent-ink">Поручили мне · {toAccept.length} {plural(toAccept.length, 'новое', 'новых', 'новых')}</h2>
          <div className="grid gap-2.5 md:grid-cols-2">
            {toAccept.map((t) => {
              const p = projects.get(t.projectId);
              const from = people.get(t.authorId);
              return (
                <div key={t.id} className="flex flex-col gap-2.5 rounded-xl border border-accent/40 bg-surface-raised p-3.5 shadow-[0_0_0_3px_rgb(var(--accent)/0.08)]">
                  <span className="flex items-center gap-2 text-xs text-ink-muted">
                    <Avatar avatarUrl={from?.avatarUrl} displayName={from?.displayName ?? '?'} size="xs" />
                    {from?.displayName ?? 'Коллега'} · <ProjectTag project={p} />
                  </span>
                  <button type="button" onClick={() => props.onOpen(t)} className="text-left text-[15px] font-semibold hover:text-accent">
                    {t.title}
                  </button>
                  <span className="flex flex-wrap gap-1.5">
                    <DueChip task={t} today={today} withRel />
                    <DeadlineChip task={t} today={today} />
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <button type="button" className="btn bg-[#16A34A] text-white hover:bg-[#15803D]" disabled={busy === t.id} onClick={() => void respond(t, 'accept')}>
                      Принять
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => props.onOpen(t)}>
                      Уточнить
                    </button>
                    <button type="button" className="btn-ghost text-danger" onClick={() => void respond(t, 'decline')}>
                      Отклонить
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {tab === 'mine' &&
        groups
          .filter((g) => g.items.length)
          .map((g) => (
            <section key={g.title} className="flex flex-col gap-1.5">
              <h2 className={clsx('section-label px-1', g.tone)}>
                {g.title} · {g.items.length}
              </h2>
              <div className="card overflow-hidden">
                {g.items.map((t) => (
                  <TaskRow key={t.id} t={t} p={projects.get(t.projectId)} props={props} />
                ))}
              </div>
            </section>
          ))}
      {tab === 'mine' && !mine.length && !toAccept.length && (
        <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center">
          <CheckCircle2 size={28} className="text-[#16A34A]" />
          <p className="font-medium">Всё сделано</p>
          <p className="text-sm text-ink-muted">Новых задач нет. Создайте свою или поручите коллеге.</p>
          <button type="button" className="btn-primary mt-2" onClick={() => props.onCreate()}>
            <Plus size={14} />
            Задача
          </button>
        </div>
      )}
      {tab === 'mine' && recentDone.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h2 className="section-label px-1">Сделано за неделю · {recentDone.length}</h2>
          <div className="card overflow-hidden opacity-80">
            {recentDone.slice(0, 8).map((t) => (
              <TaskRow key={t.id} t={t} p={projects.get(t.projectId)} props={props} />
            ))}
          </div>
        </section>
      )}

      {tab === 'control' &&
        controlGroups
          .filter((g) => g.items.length)
          .map((g) => (
            <section key={g.title} className="flex flex-col gap-1.5">
              <h2 className={clsx('section-label px-1', g.tone)}>
                {g.title} · {g.items.length}
              </h2>
              <div className="card overflow-hidden">
                {g.items.map((t) => (
                  <TaskRow
                    key={t.id}
                    t={t}
                    p={projects.get(t.projectId)}
                    props={props}
                    extra={
                      g.title === 'Ждут моей проверки' ? (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            void respond(t, 'approve');
                          }}
                          onKeyDown={(e) => e.key === 'Enter' && void respond(t, 'approve')}
                          className="inline-flex h-[22px] items-center rounded-md bg-[#16A34A] px-2 text-xs font-medium text-white"
                        >
                          Принять работу
                        </span>
                      ) : t.acceptance === 'declined' && t.declineReason ? (
                        <span className="text-xs text-danger">«{t.declineReason}»</span>
                      ) : null
                    }
                  />
                ))}
              </div>
            </section>
          ))}
      {tab === 'control' && !control.length && (
        <div className="card px-6 py-10 text-center text-sm text-ink-muted">Вы пока никому не поручали задач. Назначьте ответственного при создании — и задача появится здесь.</div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ доска

export function BoardView(props: ViewProps & { project: TaskProject }) {
  const { tasks, project, people, today } = props;
  const byId = useById(props.allTasks);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<Task['status'] | null>(null);

  const move = async (t: Task, status: Task['status']) => {
    if (t.status === status) return;
    try {
      const r = await tasksApi.update(t.projectId, t.id, { status });
      upsertTask(r.task);
      if (r.submittedInstead) props.onError('Отправлено на проверку постановщику — закрыть задачу может только он');
    } catch (err) {
      props.onError(err instanceof Error ? err.message : 'Не удалось переместить');
    }
  };

  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-4 md:mx-0 md:px-0">
      <div className="grid min-w-[1000px] grid-cols-4 items-start gap-3">
        {BOARD_COLUMNS.map((status) => {
          const items = tasks.filter((t) => t.status === status).sort((a, b) => a.order - b.order || a.number - b.number);
          return (
            <section
              key={status}
              aria-label={STATUS_META[status].label}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(status);
              }}
              onDragLeave={() => setOver((s) => (s === status ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const t = dragId ? byId.get(dragId) : null;
                setDragId(null);
                if (t) void move(t, status);
              }}
              className={clsx('flex min-h-[200px] flex-col gap-2 rounded-xl bg-surface-panel p-2.5 transition-colors', over === status && 'bg-accent-soft/70 ring-2 ring-accent/40')}
            >
              <h3 className="flex items-center gap-2 px-1 pb-1 text-[13px] font-semibold">
                <span className={clsx('h-2 w-2 rounded-full', STATUS_META[status].dot)} />
                {STATUS_META[status].label}
                <span className="font-medium text-ink-faint">{items.length}</span>
                {status !== 'done' && (
                  <button type="button" onClick={() => props.onCreate({ status, projectId: project.id })} className="btn-icon-sm ml-auto" aria-label={`Новая задача: ${STATUS_META[status].label}`}>
                    <Plus size={14} />
                  </button>
                )}
              </h3>
              {items.map((t) => {
                const blockers = blockersOf(t, byId);
                const subDone = t.subtasks.filter((s) => s.done).length;
                return (
                  <button
                    key={t.id}
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      setDragId(t.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => props.onOpen(t)}
                    className={clsx(
                      'flex flex-col gap-2 rounded-lg border border-line/[0.08] bg-surface-raised p-3 text-left shadow-xs transition hover:border-accent/40',
                      dragId === t.id && 'opacity-50',
                      status === 'done' && 'opacity-70',
                    )}
                  >
                    <span className="flex items-center gap-2 text-[11.5px] font-medium text-ink-faint">
                      {taskKey(project, t)}
                      {t.acceptance === 'pending' && t.assigneeId !== t.authorId && <span className="rounded bg-accent-soft px-1 text-accent-ink">ждёт принятия</span>}
                      {t.acceptance === 'declined' && <span className="rounded bg-danger/10 px-1 text-danger">отклонена</span>}
                    </span>
                    <span className={clsx('text-[14px] font-medium leading-snug', status === 'done' && 'line-through decoration-ink-faint')}>{t.title}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <DueChip task={t} today={today} />
                      <DeadlineChip task={t} today={today} />
                      <BlockedChip blockers={blockers} project={project} />
                      <DateIssueChip task={t} byId={byId} project={project} />
                      <span className="ml-auto">
                        <PeopleStack ids={[t.assigneeId, ...t.coAssigneeIds]} people={people} />
                      </span>
                    </span>
                    {(t.subtasks.length > 0 || t.pageRefs.length > 0) && (
                      <span className="flex items-center gap-3 text-xs text-ink-muted">
                        {t.subtasks.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <CheckCircle2 size={12} />
                            {subDone} из {t.subtasks.length}
                          </span>
                        )}
                        {t.pageRefs.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <Link2 size={12} />
                            {t.pageRefs.length}
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ список

export function ListView(props: ViewProps & { project: TaskProject; showClosed: boolean }) {
  const { tasks, project, people, today } = props;
  const byId = useById(props.allTasks);
  const [sort, setSort] = useState<'due' | 'number' | 'status'>('due');
  const order: Task['status'][] = ['review', 'in_progress', 'new', 'postponed', 'done', 'canceled'];
  const list = [...tasks]
    .filter((t) => props.showClosed || isOpen(t))
    .sort((a, b) =>
      sort === 'due' ? (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9') : sort === 'number' ? b.number - a.number : order.indexOf(a.status) - order.indexOf(b.status),
    );
  const th = (id: typeof sort, label: string, cls = '') => (
    <th className={clsx('px-3 py-2 font-medium', cls)}>
      <button type="button" onClick={() => setSort(id)} className={clsx(sort === id && 'text-ink')}>
        {label}
        {sort === id ? ' ↓' : ''}
      </button>
    </th>
  );
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-[13.5px]">
        <thead className="border-b border-line/[0.07] text-xs text-ink-muted">
          <tr>
            {th('number', '№', 'w-20')}
            <th className="px-3 py-2 font-medium">Задача</th>
            {th('status', 'Статус', 'w-36')}
            <th className="w-40 px-3 py-2 font-medium">Люди</th>
            {th('due', 'Срок', 'w-40')}
            <th className="w-28 px-3 py-2 font-medium">Дедлайн</th>
          </tr>
        </thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id} onClick={() => props.onOpen(t)} className="cursor-pointer border-b border-line/[0.05] last:border-b-0 hover:bg-surface-hover/70">
              <td className="px-3 py-2.5 text-xs text-ink-faint">{taskKey(project, t)}</td>
              <td className="px-3 py-2.5">
                <span className={clsx('font-medium', t.status === 'done' && 'text-ink-faint line-through')}>{t.title}</span>
                <span className="ml-2 inline-flex gap-1 align-middle">
                  <BlockedChip blockers={blockersOf(t, byId)} project={project} />
                  <DateIssueChip task={t} byId={byId} project={project} />
                </span>
              </td>
              <td className="px-3 py-2.5">
                <StatusChip status={t.status} />
              </td>
              <td className="px-3 py-2.5">
                <PeopleStack ids={[t.assigneeId, ...t.coAssigneeIds]} people={people} />
              </td>
              <td className="px-3 py-2.5">
                <DueChip task={t} today={today} />
              </td>
              <td className="px-3 py-2.5">
                <DeadlineChip task={t} today={today} />
              </td>
            </tr>
          ))}
          {!list.length && (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-ink-muted">
                Задач нет
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ календарь месяца

export function CalendarView(props: ViewProps & { onSubscribe: () => void }) {
  const { tasks, projects, today } = props;
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const first = `${month}-01`;
  const gridStart = addDays(first, -weekday(first));
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const lastRowNeeded = days.slice(35).some((d) => d.startsWith(month));
  const shown = lastRowNeeded ? days : days.slice(0, 35);
  const [y, m] = month.split('-').map(Number);
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
  };
  const overdue = tasks.filter((t) => isOpen(t) && t.dueDate && t.dueDate < today);
  const noDate = tasks.filter((t) => isOpen(t) && !t.dueDate && !t.deadline);

  const eventsOn = (d: string) => {
    const out: { t: Task; kind: 'due' | 'deadline' }[] = [];
    for (const t of tasks) {
      if (t.status === 'canceled') continue;
      if (t.dueDate === d) out.push({ t, kind: 'due' });
      if (t.deadline === d) out.push({ t, kind: 'deadline' });
    }
    return out;
  };

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-[999_1_640px]">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button type="button" className="btn-icon" onClick={() => shift(-1)} aria-label="Предыдущий месяц">
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="btn-secondary" onClick={() => setMonth(today.slice(0, 7))}>
            Сегодня
          </button>
          <button type="button" className="btn-icon" onClick={() => shift(1)} aria-label="Следующий месяц">
            <ChevronRight size={16} />
          </button>
          <h2 className="ml-1 text-[17px] font-semibold">
            {MONTH_NAMES[m! - 1]} {y}
          </h2>
        </div>
        <div className="overflow-hidden rounded-xl border border-line/[0.08]">
          <div className="grid grid-cols-7 border-b border-line/[0.08] bg-surface-panel text-xs font-semibold text-ink-muted">
            {WEEKDAYS.map((w) => (
              <span key={w} className="px-2 py-2">
                {w}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {shown.map((d, i) => {
              const ev = eventsOn(d);
              const inMonth = d.startsWith(month);
              return (
                <div
                  key={d}
                  className={clsx(
                    'group relative flex min-h-[92px] flex-col gap-1 border-b border-r border-line/[0.06] p-1.5 md:min-h-[112px]',
                    i % 7 === 6 && 'border-r-0',
                    i % 7 >= 5 && 'bg-surface-panel/60',
                  )}
                >
                  <span className="flex items-center justify-between">
                    <span
                      className={clsx(
                        'flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1 text-xs font-medium',
                        d === today ? 'bg-accent text-white' : inMonth ? 'text-ink' : 'text-ink-faint',
                      )}
                    >
                      {Number(d.slice(8))}
                    </span>
                    <button type="button" onClick={() => props.onCreate({ dueDate: d })} className="btn-icon-sm opacity-0 group-hover:opacity-100 max-md:hidden" aria-label={`Новая задача на ${fmtDate(d)}`}>
                      <Plus size={12} />
                    </button>
                  </span>
                  {ev.slice(0, 4).map(({ t, kind }) => {
                    const p = projects.get(t.projectId);
                    const late = isOpen(t) && d < today;
                    return (
                      <button
                        key={`${t.id}-${kind}`}
                        type="button"
                        onClick={() => props.onOpen(t)}
                        title={`${taskKey(p, t)} ${t.title} — ${kind === 'due' ? 'срок' : 'дедлайн'}`}
                        className={clsx(
                          'flex items-center gap-1 truncate rounded-md px-1.5 py-[3px] text-left text-[11.5px] font-medium',
                          kind === 'deadline' ? (late ? 'border border-danger text-danger' : 'border border-line/25 text-ink-muted') : late ? 'bg-danger/10 text-danger' : 'text-ink',
                          t.status === 'done' && 'line-through opacity-60',
                        )}
                        style={kind === 'due' && !late ? { background: `${projectColor(p)}22` } : undefined}
                      >
                        {kind === 'deadline' ? <Flag size={10} className="shrink-0" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: projectColor(p) }} />}
                        <span className="truncate">{t.title}</span>
                      </button>
                    );
                  })}
                  {ev.length > 4 && <span className="px-1 text-[11px] text-ink-muted">ещё {ev.length - 4}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <aside className="flex min-w-[240px] max-w-[300px] flex-1 flex-col gap-3">
        {overdue.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-xl bg-danger/5 p-3.5">
            <h3 className="text-[13px] font-semibold text-danger">Просрочено · {overdue.length}</h3>
            {overdue.slice(0, 6).map((t) => (
              <button key={t.id} type="button" onClick={() => props.onOpen(t)} className="truncate text-left text-[13px] hover:underline">
                {t.title} — {fmtDate(t.dueDate)}
              </button>
            ))}
          </div>
        )}
        {noDate.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-xl bg-surface-panel p-3.5">
            <h3 className="text-[13px] font-semibold">Без срока · {noDate.length}</h3>
            {noDate.slice(0, 8).map((t) => (
              <button key={t.id} type="button" onClick={() => props.onOpen(t)} className="truncate rounded-md border border-line/[0.08] bg-surface-raised px-2.5 py-1.5 text-left text-[13px]">
                {t.title}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-2 rounded-xl bg-surface-panel p-3.5 text-[12.5px]">
          <h3 className="text-[13px] font-semibold">Обозначения</h3>
          <span className="flex items-center gap-2"><span className="rounded bg-accent/15 px-1.5 font-medium">Срок</span>когда планируем закончить</span>
          <span className="flex items-center gap-2"><span className="inline-flex items-center gap-1 rounded border border-danger px-1.5 font-medium text-danger"><Flag size={10} />Дедлайн</span>нельзя пропустить</span>
        </div>
        <div className="flex flex-col gap-2 rounded-xl bg-surface-panel p-3.5">
          <h3 className="text-[13px] font-semibold">В своём календаре</h3>
          <p className="text-[12.5px] text-ink-muted">Ваши сроки и дедлайны в Google, Outlook или Apple Календаре — обновляются сами.</p>
          <button type="button" className="btn-secondary" onClick={props.onSubscribe}>
            Подписаться на календарь
          </button>
        </div>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ таймлайн (из B)

const DAY_W = 34;
const ROW_H = 44;

export function TimelineView(props: ViewProps & { project: TaskProject }) {
  const { tasks, project, people, today } = props;
  const [critical, setCritical] = useState(true);
  const byIdAll = useById(props.allTasks);
  const issuesOf = (t: Task) => dateIssues(t, byIdAll);
  const keyOf = (t: Task) => `${project.key}-${t.number}`;
  const rows = useMemo(
    () =>
      tasks
        .filter((t) => t.status !== 'canceled' && (t.startDate || t.dueDate))
        .sort((a, b) => (a.startDate ?? a.dueDate ?? '').localeCompare(b.startDate ?? b.dueDate ?? '') || a.number - b.number),
    [tasks],
  );
  const undated = tasks.filter((t) => isOpen(t) && !t.startDate && !t.dueDate);

  // Диапазон: от самой ранней даты (не позже чем неделя назад) до самой поздней + неделя.
  const dates = rows.flatMap((t) => [t.startDate, t.dueDate, t.deadline]).filter((x): x is string => !!x);
  const minD = [addDays(today, -7), ...dates].sort()[0]!;
  const start = addDays(minD, -weekday(minD));
  const maxD = [addDays(today, 21), ...dates].sort().slice(-1)[0]!;
  const span = Math.min(180, diffDays(maxD, start) + 8);
  const days = Array.from({ length: span }, (_, i) => addDays(start, i));
  const x = (d: string) => diffDays(d, start) * DAY_W;

  const index = new Map(rows.map((t, i) => [t.id, i]));
  // Критический путь: цепочка «ждёт», ведущая к задаче с самым поздним сроком.
  const crit = useMemo(() => {
    const set = new Set<string>();
    const last = [...rows].filter(isOpen).sort((a, b) => (b.dueDate ?? '').localeCompare(a.dueDate ?? ''))[0];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const walk = (t: Task | undefined) => {
      if (!t || set.has(t.id)) return;
      set.add(t.id);
      const prev = t.dependsOn.map((id) => byId.get(id)).filter((d): d is Task => !!d && isOpen(d)).sort((a, b) => (b.dueDate ?? '').localeCompare(a.dueDate ?? ''))[0];
      walk(prev);
    };
    if (last && (last.dependsOn.length || tasks.some((t) => t.dependsOn.includes(last.id)))) walk(last);
    return set.size > 1 ? set : new Set<string>();
  }, [rows, tasks]);

  const barStyle = (t: Task): string => {
    if (t.status === 'done') return 'bg-[#DCFCE7] text-[#166534] dark:bg-[#14301F] dark:text-[#86EFAC]';
    if (t.status === 'review') return 'bg-[#FEF3C7] text-[#92400E] dark:bg-[#4A3612] dark:text-[#FCD58A]';
    if (t.dueDate && t.dueDate < today) return 'bg-danger/80 text-white';
    if (t.status === 'in_progress') return 'bg-accent text-white';
    return 'bg-surface-hover text-ink border border-line/15';
  };

  const arrows: { d: string; crit: boolean; level: 'warn' | 'error' | null }[] = [];
  let issueCount = 0;
  for (const t of rows) {
    const tIssues = issuesOf(t);
    if (tIssues.length) issueCount++;
    for (const depId of t.dependsOn) {
      const from = rows.find((r) => r.id === depId);
      if (!from) continue;
      const fi = index.get(from.id)!;
      const ti = index.get(t.id)!;
      const x1 = x(from.dueDate ?? from.startDate!) + DAY_W;
      const y1 = fi * ROW_H + ROW_H / 2;
      const x2 = x(t.startDate ?? t.dueDate!);
      const y2 = ti * ROW_H + ROW_H / 2;
      const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 12));
      const level = worstLevel(tIssues.filter((i) => i.other?.id === from.id));
      arrows.push({ d: `M${x1} ${y1}H${mid}V${y2}H${x2 - 2}`, crit: critical && crit.has(t.id) && crit.has(from.id), level });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-muted">
        <button type="button" onClick={() => setCritical((v) => !v)} aria-pressed={critical} className={clsx('btn-secondary', critical && crit.size && 'border-[#D97706] text-[#92400E] dark:text-[#FCD58A]')}>
          Критический путь
        </button>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-5 rounded bg-accent" />в работе</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-5 rounded border border-line/15 bg-surface-hover" />не начата</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-5 rounded bg-danger/80" />просрочена</span>
        <span className="flex items-center gap-1.5"><Flag size={12} className="text-danger" />дедлайн</span>
        <span className="flex items-center gap-1.5"><span className="tl-overlap h-2.5 w-5 rounded" />пересечение дат</span>
        {issueCount > 0 && (
          <span className="flex items-center gap-1 font-medium text-[#92400E] dark:text-[#FCD58A]">
            <AlertTriangle size={12} />
            {issueCount} {plural(issueCount, 'задача', 'задачи', 'задач')} с нелогичными датами
          </span>
        )}
        {critical && crit.size > 0 && <span>Цепочка {crit.size} {plural(crit.size, 'задачи', 'задач', 'задач')} определяет дату окончания</span>}
      </div>
      <div className="card flex overflow-hidden">
        <div className="w-[240px] shrink-0 border-r border-line/[0.07] md:w-[300px]">
          <div className="flex h-12 items-end border-b border-line/[0.07] px-3 pb-2 text-xs text-ink-muted">Задача</div>
          {rows.map((t) => (
            <button key={t.id} type="button" onClick={() => props.onOpen(t)} className="flex w-full items-center gap-2 border-b border-line/[0.04] px-3 text-left text-[13px] hover:bg-surface-hover" style={{ height: ROW_H }}>
              <span className="shrink-0 text-[11px] text-ink-faint">{project.key}-{t.number}</span>
              <span className={clsx('min-w-0 flex-1 truncate', t.status === 'done' && 'text-ink-faint')}>{t.title}</span>
              <PeopleStack ids={[t.assigneeId]} people={people} />
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div style={{ width: days.length * DAY_W }} className="relative">
            <div className="flex h-12 border-b border-line/[0.07] text-[11px] text-ink-muted">
              {days.map((d) => (
                <span key={d} className={clsx('flex shrink-0 flex-col items-center justify-end pb-1.5', weekday(d) >= 5 && 'bg-surface-panel', d === today && 'font-bold text-accent')} style={{ width: DAY_W }}>
                  {d.endsWith('-01') || d === days[0] ? <span className="text-[10px]">{MONTH_NAMES[Number(d.slice(5, 7)) - 1]!.slice(0, 3).toLowerCase()}</span> : null}
                  {Number(d.slice(8))}
                </span>
              ))}
            </div>
            <div className="relative" style={{ height: Math.max(rows.length, 1) * ROW_H }}>
              {days.map((d, i) => (weekday(d) >= 5 ? <span key={d} className="absolute inset-y-0 bg-surface-panel" style={{ left: i * DAY_W, width: DAY_W }} /> : null))}
              {today >= start && <span className="absolute inset-y-0 w-0.5 bg-accent" style={{ left: x(today) + DAY_W / 2 }} />}
              <svg className="pointer-events-none absolute inset-0" width={days.length * DAY_W} height={rows.length * ROW_H} aria-hidden>
                <defs>
                  <marker id="tl-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" style={{ fill: 'rgb(var(--ink-faint))' }} /></marker>
                  <marker id="tl-c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" fill="#D97706" /></marker>
                  <marker id="tl-e" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" style={{ fill: 'rgb(var(--danger))' }} /></marker>
                </defs>
                {arrows.map((a, i) => {
                  // Конфликт дат важнее подсветки критического пути: стрелка пунктирная.
                  const stroke = a.level === 'error' ? 'rgb(var(--danger))' : a.level === 'warn' || a.crit ? '#D97706' : 'rgb(var(--ink-faint))';
                  const marker = a.level === 'error' ? 'url(#tl-e)' : a.level === 'warn' || a.crit ? 'url(#tl-c)' : 'url(#tl-a)';
                  return <path key={i} d={a.d} fill="none" style={{ stroke }} strokeWidth={a.crit || a.level ? 2 : 1.4} strokeDasharray={a.level ? '4 3' : undefined} markerEnd={marker} />;
                })}
              </svg>
              {rows.map((t, i) => {
                const s = t.startDate ?? t.dueDate!;
                const e = t.dueDate && t.dueDate >= s ? t.dueDate : s;
                const issues = issuesOf(t);
                const level = worstLevel(issues);
                const issueText = issues.map((iss) => describeDateIssue(iss, keyOf)).join('\n');
                // Полоса пересечения: от начала задачи до окончания той, которую она ждёт.
                const overlapEnd = issues.filter((iss) => iss.other?.dueDate && (iss.kind === 'overlap' || iss.kind === 'order')).map((iss) => iss.other!.dueDate!).sort().slice(-1)[0];
                const overlapTo = overlapEnd && (overlapEnd < e ? overlapEnd : e);
                return (
                  <span key={t.id}>
                    {overlapTo && overlapTo >= s && (
                      <span
                        className={clsx('tl-overlap absolute h-8 rounded-md', level === 'error' && 'tl-overlap-error')}
                        title={issueText}
                        style={{ left: x(s) + 1, width: (diffDays(overlapTo, s) + 1) * DAY_W - 2, top: i * ROW_H + 6 }}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => props.onOpen(t)}
                      title={`${t.title}: ${fmtDate(s)} – ${fmtDate(e)}${issueText ? `\n⚠ ${issueText}` : ''}`}
                      className={clsx(
                        'absolute flex h-6 items-center gap-1 overflow-hidden whitespace-nowrap rounded-md px-2 text-[11.5px] font-medium',
                        barStyle(t),
                        critical && crit.has(t.id) && 'ring-2 ring-[#D97706]',
                        level === 'error' && 'outline outline-2 outline-offset-2 outline-danger',
                      )}
                      style={{ left: x(s) + 3, width: (diffDays(e, s) + 1) * DAY_W - 6, top: i * ROW_H + 10 }}
                    >
                      {level && <AlertTriangle size={11} className="shrink-0" />}
                      {t.title}
                    </button>
                    {t.deadline && (
                      <span className="absolute text-danger" title={`Дедлайн ${fmtDate(t.deadline)}`} style={{ left: x(t.deadline) + 10, top: i * ROW_H + 13 }}>
                        <Flag size={14} />
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {undated.length > 0 && <p className="text-xs text-ink-muted">Без дат и поэтому не на шкале: {undated.map((t) => t.title).join(', ')}.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ загрузка людей (из B)

export function WorkloadView(props: ViewProps) {
  const { tasks, people, today, projects } = props;
  const [open, setOpen] = useState<string | null>(null);
  // 10 рабочих дней начиная с сегодня.
  const days: string[] = [];
  for (let d = today; days.length < 10; d = addDays(d, 1)) if (weekday(d) < 5) days.push(d);
  const active = tasks.filter((t) => isOpen(t) && (t.dueDate || t.startDate));
  const covers = (t: Task, d: string) => {
    const s = t.startDate ?? t.dueDate!;
    const e = t.dueDate ?? t.startDate!;
    return d >= s && d <= e;
  };
  const ids = [...new Set(active.flatMap((t) => [t.assigneeId, ...t.coAssigneeIds]).filter((x): x is string => !!x))];
  const rows = ids
    .map((id) => {
      const mine = active.filter((t) => t.assigneeId === id || t.coAssigneeIds.includes(id));
      return { id, mine, load: days.map((d) => mine.filter((t) => covers(t, d)).length) };
    })
    .sort((a, b) => Math.max(...b.load) - Math.max(...a.load));
  const peak = rows.find((r) => Math.max(...r.load) >= 3);
  const cell = (n: number) => (n === 0 ? 'bg-surface-panel text-ink-faint' : n === 1 ? 'bg-accent/20 text-accent-ink' : n === 2 ? 'bg-accent/50 text-white' : 'bg-danger/80 text-white');

  return (
    <div className="flex flex-col gap-4">
      {peak && (
        <p className="rounded-xl bg-danger/5 px-4 py-3 text-sm">
          <b>{people.get(peak.id)?.displayName ?? 'Сотрудник'}</b> перегружен(а): {Math.max(...peak.load)} задачи одновременно. Передайте часть тем, у кого светлые клетки.
        </p>
      )}
      <div className="card overflow-x-auto p-3">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[220px_repeat(10,minmax(48px,1fr))] gap-1 pb-1 text-center text-xs text-ink-muted">
            <span />
            {days.map((d) => (
              <span key={d} className={clsx(d === today && 'font-bold text-accent')}>
                {WEEKDAYS[weekday(d)]} {Number(d.slice(8))}
              </span>
            ))}
          </div>
          {rows.map((r) => {
            const p = people.get(r.id);
            return (
              <div key={r.id}>
                <div className="grid grid-cols-[220px_repeat(10,minmax(48px,1fr))] items-center gap-1 py-0.5">
                  <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} className="flex min-h-[44px] items-center gap-2.5 rounded-lg px-1.5 text-left hover:bg-surface-hover">
                    <Avatar avatarUrl={p?.avatarUrl} displayName={p?.displayName ?? '?'} size="sm" />
                    <span className="min-w-0 leading-tight">
                      <span className="block truncate text-[13.5px] font-medium">{p?.displayName ?? 'Сотрудник'}</span>
                      <span className="text-xs text-ink-muted">{r.mine.length} {plural(r.mine.length, 'задача', 'задачи', 'задач')}</span>
                    </span>
                  </button>
                  {r.load.map((n, i) => (
                    <span key={i} className={clsx('flex h-10 items-center justify-center rounded-md text-xs font-semibold', cell(n))} title={`${fmtDate(days[i])}: ${n}`}>
                      {n || ''}
                    </span>
                  ))}
                </div>
                {open === r.id && (
                  <div className="mb-2 ml-[224px] flex flex-col gap-1">
                    {r.mine.map((t) => (
                      <button key={t.id} type="button" onClick={() => props.onOpen(t)} className="flex items-center gap-2 rounded-md bg-surface-panel px-3 py-2 text-left text-[13px] hover:bg-surface-hover">
                        <span className="h-2 w-2 rounded-[3px]" style={{ background: projectColor(projects.get(t.projectId)) }} />
                        <span className="flex-1 truncate">{t.title}</span>
                        <span className="text-xs text-ink-muted">{t.startDate ? `${fmtDate(t.startDate)} – ` : 'до '}{fmtDate(t.dueDate)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {!rows.length && <p className="py-6 text-center text-sm text-ink-muted">Нет задач с датами — загрузку не из чего посчитать.</p>}
        </div>
      </div>
      <p className="text-xs text-ink-muted">Считаются открытые задачи с датами: задача занимает человека от начала до срока. Ответственный и соисполнители учитываются одинаково.</p>
    </div>
  );
}
