'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import {
  BarChart3,
  CalendarDays,
  Copy,
  GanttChart,
  KanbanSquare,
  List,
  Loader2,
  Plus,
  Search,
  Lock,
  Settings2,
  SquareCheckBig,
  User,
} from 'lucide-react';
import { useSession } from '../../components/SessionProvider';
import { ToastProvider, useToast } from '../../components/Toast';
import { AppShell, FullScreenLoader, SignInRequired } from '../../components/AppShell';
import { tasksApi, type Task, type TaskProject } from '../../lib/api';
import { actionItems, isOpen, projectColor, getTasksState, refreshTasks, useTasks } from '../../lib/tasks';
import { TaskDrawer } from '../../components/tasks/TaskDrawer';
import { NewTaskDialog, ProjectDialog, type NewTaskPrefill } from '../../components/tasks/TaskDialogs';
import { BoardView, CalendarView, ListView, MyTasksView, TimelineView, WorkloadView, type ViewProps } from '../../components/tasks/TaskViews';
import { PeopleStack } from '../../components/tasks/TaskBits';

type View = 'my' | 'calendar' | 'load' | 'board' | 'list' | 'timeline' | 'pcalendar';

export default function TasksPage() {
  return (
    <ToastProvider>
      <Suspense fallback={<FullScreenLoader />}>
        <TasksScreen />
      </Suspense>
    </ToastProvider>
  );
}

function TasksScreen() {
  const { user, accessToken, isLoading } = useSession();
  const { push } = useToast();
  const router = useRouter();
  const pathname = usePathname() ?? '/tasks';
  const params = useSearchParams();
  const data = useTasks(accessToken);
  const projectId = params?.get('project') ?? null;
  const taskId = params?.get('task') ?? null;
  const view = ((params?.get('view') as View | null) ?? (projectId ? 'board' : 'my')) as View;
  const [newTask, setNewTask] = useState<NewTaskPrefill | null>(null);
  const [projectDialog, setProjectDialog] = useState<'new' | TaskProject | null>(null);
  const [ical, setIcal] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [calScope, setCalScope] = useState<'mine' | 'all'>('mine');

  const go = useCallback(
    (next: { project?: string | null; view?: View | null; task?: string | null }) => {
      const sp = new URLSearchParams(params?.toString() ?? '');
      for (const [k, v] of Object.entries(next)) {
        if (v === undefined) continue;
        if (v === null) sp.delete(k);
        else sp.set(k, v);
      }
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const projects = data.projects;
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  // Свои задачи + закрытые карточки связанных чужих — для блокировок и проверки дат.
  const knownTasks = useMemo(() => [...data.tasks, ...data.hidden], [data.tasks, data.hidden]);
  const project = projectId ? projectMap.get(projectId) : undefined;
  const openTask = taskId ? data.tasks.find((t) => t.id === taskId) : undefined;
  const openTaskProject = openTask ? projectMap.get(openTask.projectId) : undefined;

  // Ссылка на задачу, которой нет в загруженном (например, только что созданную в другом окне) — обновим один раз.
  // Если и после этого её нет — она удалена или вы в ней не участвуете: скажем об этом и закроем ссылку.
  useEffect(() => {
    if (!taskId || !data.loaded || openTask) return;
    let cancelled = false;
    void refreshTasks().then(() => {
      if (cancelled || getTasksState().tasks.some((t) => t.id === taskId)) return;
      push('Задача не найдена или вы в ней не участвуете', 'error');
      go({ task: null });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, data.loaded, !!openTask]);

  if (isLoading) return <FullScreenLoader />;
  if (!user) return <SignInRequired />;

  const meId = user.id;
  const role = (user.role ?? 'Member') as 'Admin' | 'Team-Lead' | 'Member' | 'Guest';
  const counts = actionItems(data.tasks, meId, data.today);

  const needle = query.trim().toLowerCase();
  const filterTasks = (list: Task[]) =>
    list.filter(
      (t) =>
        (!needle || t.title.toLowerCase().includes(needle) || `${projectMap.get(t.projectId)?.key}-${t.number}`.toLowerCase().includes(needle)) &&
        (!onlyMine || t.assigneeId === meId || t.coAssigneeIds.includes(meId) || t.authorId === meId),
    );
  const projectTasks = project ? filterTasks(data.tasks.filter((t) => t.projectId === project.id)) : [];
  const mineAll = data.tasks.filter((t) => t.assigneeId === meId || t.coAssigneeIds.includes(meId) || t.authorId === meId);

  const viewProps = (tasks: Task[]): ViewProps => ({
    tasks,
    allTasks: knownTasks,
    projects: projectMap,
    people: data.people,
    meId,
    today: data.today,
    onOpen: (t) => go({ task: t.id }),
    onCreate: (prefill) => setNewTask({ projectId: prefill?.projectId ?? projectId, dueDate: prefill?.dueDate ?? null, status: prefill?.status }),
    onError: (m) => push(m, 'info'),
  });

  const subscribe = async () => {
    try {
      setIcal((await tasksApi.icalUrl()).url);
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось получить ссылку', 'error');
    }
  };

  const navItem = (active: boolean) => clsx('nav-item', active && 'nav-item-active');
  const canManage = (p: TaskProject) => role === 'Admin' || role === 'Team-Lead' || p.createdBy === meId;
  /** Видит все задачи проекта, а не только свои (см. настройку «Видимость задач» в админке). */
  const seesAll = (p: TaskProject) => canManage(p) || data.visibility === 'project';

  const projectViews: { id: View; label: string; icon: typeof List }[] = [
    { id: 'board', label: 'Доска', icon: KanbanSquare },
    { id: 'list', label: 'Список', icon: List },
    { id: 'pcalendar', label: 'Календарь', icon: CalendarDays },
    { id: 'timeline', label: 'Таймлайн', icon: GanttChart },
  ];

  const title = project ? project.name : view === 'calendar' ? 'Календарь' : view === 'load' ? 'Загрузка команды' : 'Мои задачи';

  return (
    <AppShell flush fab={{ icon: <Plus size={24} />, label: 'Новая задача', onClick: () => setNewTask({ projectId }) }}>
      <div className="flex min-h-0 w-full flex-1">
        {/* Навигация раздела (компьютер) */}
        <aside className="hidden w-[248px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line/[0.06] p-2.5 lg:flex">
          <button type="button" className={navItem(!project && view === 'my')} onClick={() => go({ project: null, view: null })}>
            <User size={16} className="text-ink-faint" />
            <span className="flex-1 text-left">Мои задачи</span>
            {counts.count > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-[18px] text-white">{counts.count}</span>}
          </button>
          <button type="button" className={navItem(!project && view === 'calendar')} onClick={() => go({ project: null, view: 'calendar' })}>
            <CalendarDays size={16} className="text-ink-faint" />
            Календарь
          </button>
          <button type="button" className={navItem(!project && view === 'load')} onClick={() => go({ project: null, view: 'load' })}>
            <BarChart3 size={16} className="text-ink-faint" />
            Загрузка команды
          </button>
          <div className="section-label mb-1 mt-5">Проекты</div>
          {projects.map((p) => {
            const open = data.tasks.filter((t) => t.projectId === p.id && isOpen(t)).length;
            return (
              <button key={p.id} type="button" className={navItem(project?.id === p.id)} onClick={() => go({ project: p.id, view: null })}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: projectColor(p) }} />
                <span className="flex-1 truncate text-left">{p.name}</span>
                <span className="text-xs text-ink-faint">{open || ''}</span>
              </button>
            );
          })}
          <button type="button" className="nav-item text-ink-faint" onClick={() => setProjectDialog('new')}>
            <Plus size={16} />
            Новый проект
          </button>
        </aside>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="pb-tabbar mx-auto flex max-w-[1400px] flex-col gap-4 px-4 pb-16 pt-4 md:px-8 md:pt-8">
            {/* Шапка */}
            <header className="flex flex-wrap items-center gap-3">
              <div className="flex min-w-0 items-center gap-3">
                {project ? (
                  <span className="h-3.5 w-3.5 shrink-0 rounded" style={{ background: projectColor(project) }} />
                ) : (
                  <span className="hidden h-10 w-10 items-center justify-center rounded-xl border border-line/[0.08] bg-surface-raised text-accent shadow-xs md:flex">
                    <SquareCheckBig size={18} />
                  </span>
                )}
                <h1 className="truncate text-[28px] font-bold leading-tight tracking-tight md:text-2xl md:font-semibold">{title}</h1>
                {project && (
                  <>
                    <PeopleStack ids={project.memberIds} people={data.people} max={5} />
                    {canManage(project) && (
                      <button type="button" className="btn-icon" aria-label="Настройки проекта" onClick={() => setProjectDialog(project)}>
                        <Settings2 size={16} />
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className="ml-auto hidden items-center gap-2 md:flex">
                <button type="button" className="btn-secondary" onClick={() => void subscribe()}>
                  <CalendarDays size={14} />
                  Подписаться на календарь
                </button>
                <button type="button" className="btn-primary" onClick={() => setNewTask({ projectId })}>
                  <Plus size={14} />
                  Задача
                </button>
              </div>
            </header>

            {/* Переключатель разделов (телефон и узкие экраны) */}
            <nav className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 lg:hidden" aria-label="Разделы задач">
              {(
                [
                  ['my', 'Мои', counts.count],
                  ['calendar', 'Календарь', 0],
                  ['load', 'Загрузка', 0],
                ] as const
              ).map(([id, label, n]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => go({ project: null, view: id === 'my' ? null : id })}
                  className={clsx('h-9 shrink-0 rounded-full px-3.5 text-[13.5px] font-medium', !project && view === id ? 'bg-ink text-surface' : 'bg-surface-hover text-ink-muted')}
                >
                  {label}
                  {n ? ` · ${n}` : ''}
                </button>
              ))}
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => go({ project: p.id, view: null })}
                  className={clsx('flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13.5px] font-medium', project?.id === p.id ? 'bg-ink text-surface' : 'bg-surface-hover text-ink-muted')}
                >
                  <span className="h-2 w-2 rounded-[3px]" style={{ background: projectColor(p) }} />
                  {p.name}
                </button>
              ))}
              <button type="button" onClick={() => setProjectDialog('new')} className="h-9 shrink-0 rounded-full border border-dashed border-line/25 px-3.5 text-[13.5px] text-ink-muted">
                + Проект
              </button>
            </nav>

            {project && (
              <div className="flex flex-wrap items-center gap-2">
                <nav className="segmented" aria-label="Вид">
                  {projectViews.map(({ id, label, icon: Icon }) => (
                    <button key={id} type="button" onClick={() => go({ view: id })} className={clsx('segmented-item h-8 gap-1.5 px-2.5', view === id && 'segmented-item-active')}>
                      <Icon size={14} />
                      <span className="max-sm:hidden">{label}</span>
                    </button>
                  ))}
                </nav>
                <label className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-md border border-line/10 bg-surface-raised px-2.5 sm:flex-none">
                  <Search size={14} className="text-ink-faint" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти задачу" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
                </label>
                {seesAll(project) ? (
                  <button type="button" onClick={() => setOnlyMine((v) => !v)} aria-pressed={onlyMine} className={clsx('btn', onlyMine ? 'bg-accent-soft text-accent-ink' : 'btn-ghost')}>
                    Только мои
                  </button>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs text-ink-muted" title="Так настроено администратором: в проекте видны задачи, где вы постановщик, исполнитель или наблюдатель">
                    <Lock size={12} />
                    Видны задачи, где вы участвуете
                  </span>
                )}
                {view === 'list' && (
                  <button type="button" onClick={() => setShowClosed((v) => !v)} aria-pressed={showClosed} className={clsx('btn', showClosed ? 'bg-accent-soft text-accent-ink' : 'btn-ghost')}>
                    Показать закрытые
                  </button>
                )}
                <span className="ml-auto text-xs text-ink-muted max-md:hidden">
                  {projectTasks.filter(isOpen).length} открыто · {projectTasks.filter((t) => isOpen(t) && t.dueDate && t.dueDate < data.today).length} просрочено
                </span>
              </div>
            )}

            {!project && view === 'calendar' && (
              <div className="segmented self-start">
                {(
                  [
                    ['mine', 'Мои'],
                    ['all', 'Все проекты'],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setCalScope(id)} className={clsx('segmented-item h-8 px-3', calScope === id && 'segmented-item-active')}>
                    {label}
                  </button>
                ))}
              </div>
            )}

            {!data.loaded ? (
              <div className="flex justify-center py-16 text-ink-faint">
                <Loader2 size={20} className="animate-spin" />
              </div>
            ) : data.error ? (
              <p className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">{data.error}</p>
            ) : projectId && !project ? (
              <div className="card px-6 py-10 text-center text-sm text-ink-muted">Проект не найден или у вас нет к нему доступа.</div>
            ) : project ? (
              view === 'list' ? (
                <ListView {...viewProps(projectTasks)} project={project} showClosed={showClosed} />
              ) : view === 'pcalendar' ? (
                <CalendarView {...viewProps(projectTasks)} onSubscribe={() => void subscribe()} />
              ) : view === 'timeline' ? (
                <TimelineView {...viewProps(projectTasks)} project={project} />
              ) : (
                <BoardView {...viewProps(projectTasks)} project={project} />
              )
            ) : view === 'calendar' ? (
              <CalendarView {...viewProps(calScope === 'mine' ? mineAll : data.tasks)} onSubscribe={() => void subscribe()} />
            ) : view === 'load' ? (
              <WorkloadView {...viewProps(data.tasks)} />
            ) : !projects.length ? (
              <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center">
                <SquareCheckBig size={30} className="text-accent" />
                <p className="text-[17px] font-semibold">Здесь будут задачи команды</p>
                <p className="max-w-md text-sm text-ink-muted">Создайте проект — например, «Переезд офиса», — добавьте участников и поручайте задачи: с ответственным, соисполнителями, сроками и обсуждением.</p>
                <button type="button" className="btn-primary mt-1" onClick={() => setProjectDialog('new')}>
                  <Plus size={14} />
                  Создать проект
                </button>
              </div>
            ) : (
              <MyTasksView {...viewProps(data.tasks)} projectsList={projects} />
            )}
          </div>
        </main>
      </div>

      {openTask && openTaskProject && (
        <TaskDrawer
          key={openTask.id}
          task={openTask}
          project={openTaskProject}
          tasks={knownTasks}
          people={data.people}
          meId={meId}
          role={role}
          today={data.today}
          onClose={() => go({ task: null })}
          onOpenTask={(t) => go({ task: t.id })}
        />
      )}
      {newTask && (
        <NewTaskDialog
          projects={projects}
          people={data.people}
          meId={meId}
          prefill={newTask}
          onClose={() => setNewTask(null)}
          onCreated={(t) => {
            setNewTask(null);
            push(t.assigneeId && t.assigneeId !== meId ? 'Поручение отправлено' : 'Задача создана');
            go({ task: t.id });
          }}
        />
      )}
      {projectDialog && (
        <ProjectDialog
          project={projectDialog === 'new' ? undefined : projectDialog}
          people={data.people}
          meId={meId}
          canDelete={projectDialog !== 'new' && (role === 'Admin' || projectDialog.createdBy === meId)}
          onClose={() => setProjectDialog(null)}
          onSaved={(p) => {
            setProjectDialog(null);
            go({ project: p.id, view: null });
          }}
          onDeleted={() => {
            setProjectDialog(null);
            void refreshTasks();
            go({ project: null, view: null, task: null });
          }}
        />
      )}
      {ical && <IcalDialog url={ical} onClose={() => setIcal(null)} onRotate={async () => setIcal((await tasksApi.rotateIcal()).url)} />}
    </AppShell>
  );
}

function IcalDialog({ url, onClose, onRotate }: { url: string; onClose: () => void; onRotate: () => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Подписка на календарь" className="dialog flex max-w-lg flex-col gap-4 p-5">
        <h2 className="text-[15px] font-semibold">Подписка на календарь</h2>
        <p className="text-sm text-ink-muted">
          Сроки и дедлайны ваших задач появятся в Google, Outlook или Apple Календаре и будут обновляться сами (обычно раз в несколько часов — это решает календарь).
        </p>
        <div className="flex gap-2">
          <input readOnly value={url} className="input font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Ссылка подписки" />
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              void navigator.clipboard?.writeText(url);
              setCopied(true);
            }}
          >
            <Copy size={14} />
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-muted">
          <li><b>Google Календарь</b>: «Другие календари» → «+» → «Добавить по URL».</li>
          <li><b>Outlook</b>: «Добавить календарь» → «Подписаться из Интернета».</li>
          <li><b>Apple Календарь</b>: «Файл» → «Новая подписка на календарь».</li>
        </ul>
        <p className="text-xs text-ink-muted">Ссылка личная: по ней видны ваши задачи без входа. Если она попала не туда — сбросьте её.</p>
        <div className="flex justify-between gap-2">
          <button type="button" className="btn-ghost text-danger" onClick={() => (confirmRotate ? void onRotate().then(() => setConfirmRotate(false)) : setConfirmRotate(true))}>
            {confirmRotate ? 'Старая ссылка перестанет работать. Сбросить?' : 'Сбросить ссылку'}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}

