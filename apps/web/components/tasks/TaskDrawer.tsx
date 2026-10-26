'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  AtSign,
  Check,
  ChevronLeft,
  CircleSlash,
  FileSymlink,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { filesApi, tasksApi, type Task, type TaskActivity, type TaskProject, type UserFileInfo } from '../../lib/api';
import {
  STATUS_META,
  ISSUE_FIELD_TONE,
  addDays,
  blockersOf,
  dateIssues,
  dependentIssues,
  describeDateIssue,
  diffDays,
  fmtDate,
  worstLevel,
  type DateIssue,
  isOpen,
  onTaskActivity,
  projectColor,
  relDay,
  removeTask,
  taskKey,
  upsertTask,
  type Person,
} from '../../lib/tasks';
import { chatMarkdownToHtml } from '../../lib/pasteToBlocks';
import { canRecord, type RecordingResult } from '../../lib/mediaRecorder';
import { Avatar } from '../Avatar';
import { PageRefCard } from '../PageRefCard';
import { PagePickerDialog } from '../PagePickerDialog';
import { FilePickerDialog } from '../FilePickerDialog';
import { ChatAttachmentView } from '../ChatAttachmentView';
import { MediaRecordButton } from '../MediaRecordButton';
import { DateField, PersonPicker } from './TaskBits';
import { ReasonDialog, ShiftDialog, dependentsOf } from './TaskDialogs';

type Role = 'Admin' | 'Team-Lead' | 'Member' | 'Guest';

export function taskPermissions(project: TaskProject | undefined, task: Task, meId: string, role: Role) {
  const manage = !!project && (role === 'Admin' || role === 'Team-Lead' || project.createdBy === meId);
  const participant = task.authorId === meId || task.assigneeId === meId || task.coAssigneeIds.includes(meId);
  return { manage, edit: participant || manage, controller: task.authorId === meId || manage, isAssignee: task.assigneeId === meId };
}

function eventText(a: TaskActivity, name: (id: string | null | undefined) => string, keyById: (id: string) => string): string {
  const e = a.event!;
  const st = (s?: string | null) => (s && STATUS_META[s as Task['status']]?.label) || s || '—';
  const d = (s?: string | null) => (s ? fmtDate(s) : 'без даты');
  const why = a.text ? ` — «${a.text}»` : '';
  switch (e.type) {
    case 'created':
      return 'создал(а) задачу';
    case 'assigned':
      return e.to ? `назначил(а) ответственным: ${name(e.to)}` : 'снял(а) ответственного';
    case 'accepted':
      return 'принял(а) поручение';
    case 'declined':
      return `отклонил(а) поручение${why}`;
    case 'status':
      return `сменил(а) статус: ${st(e.from)} → ${st(e.to)}`;
    case 'due':
      return `перенёс(ла) срок: ${d(e.from)} → ${d(e.to)}${why}`;
    case 'deadline':
      return `изменил(а) дедлайн: ${d(e.from)} → ${d(e.to)}${why}`;
    case 'submitted':
      return 'сдал(а) работу на проверку';
    case 'approved':
      return 'принял(а) работу';
    case 'returned':
      return `вернул(а) на доработку${why}${e.to ? `, новый срок ${d(e.to)}` : ''}`;
    case 'shifted':
      return `срок сдвинут ${a.text || ''}: ${d(e.from)} → ${d(e.to)}`;
    case 'people':
      return 'изменил(а) соисполнителей';
    default:
      return e.type;
  }
  void keyById;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `сегодня, ${time}`;
  return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${time}`;
}

/**
 * Карточка задачи — боковая панель (на телефоне — на весь экран). Всё о
 * задаче в одном месте: люди, даты, связи, подзадачи, документы,
 * поручение (принять/отклонить), сдача и приём работы, обсуждение.
 */
export function TaskDrawer({
  task,
  project,
  tasks,
  people,
  meId,
  role,
  today,
  onClose,
  onOpenTask,
}: {
  task: Task;
  project: TaskProject;
  tasks: Task[];
  people: Map<string, Person>;
  meId: string;
  role: Role;
  today: string;
  onClose: () => void;
  onOpenTask: (t: Task) => void;
}) {
  const perm = taskPermissions(project, task, meId, role);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<TaskActivity[] | null>(null);
  const [title, setTitle] = useState(task.title);
  const [editDesc, setEditDesc] = useState(false);
  const [desc, setDesc] = useState(task.description);
  const [shift, setShift] = useState<string | null | undefined>(undefined);
  const [reasonFor, setReasonFor] = useState<'decline' | 'return' | null>(null);
  const [pagePicker, setPagePicker] = useState(false);
  const [depPicker, setDepPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newSub, setNewSub] = useState('');
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const projectTasks = useMemo(() => tasks.filter((t) => t.projectId === project.id), [tasks, project.id]);
  const blockers = blockersOf(task, byId);
  const blocks = projectTasks.filter((t) => t.dependsOn.includes(task.id));
  // Всё, что (через цепочку) ждёт эту задачу — связь с ними замкнула бы цикл, в выборе их не показываем.
  const downstreamIds = useMemo(() => {
    const seen = new Set<string>();
    const queue = [task.id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const t of projectTasks) if (t.dependsOn.includes(id) && !seen.has(t.id)) (seen.add(t.id), queue.push(t.id));
    }
    return seen;
  }, [projectTasks, task.id]);
  const name = useCallback((id: string | null | undefined) => (id ? people.get(id)?.displayName ?? 'Сотрудник' : '—'), [people]);

  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => {
    if (!editDesc) setDesc(task.description);
  }, [task.description, editDesc]);

  useEffect(() => {
    let cancelled = false;
    setActivity(null);
    tasksApi
      .get(project.id, task.id)
      .then((r) => !cancelled && setActivity(r.activity))
      .catch(() => !cancelled && setActivity([]));
    const off = onTaskActivity((p) => {
      if (p.taskId !== task.id) return;
      setActivity((prev) => {
        const list = prev ?? [];
        if ('deleted' in p.item) return list.filter((x) => x.id !== p.item.id);
        const item = p.item as TaskActivity;
        const i = list.findIndex((x) => x.id === item.id);
        if (i >= 0) {
          const next = [...list];
          next[i] = item;
          return next;
        }
        return [...list, item];
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [project.id, task.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !shift && !reasonFor && !pagePicker) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, shift, reasonFor, pagePicker]);

  const patch = async (input: Parameters<typeof tasksApi.update>[2]) => {
    setError(null);
    try {
      const r = await tasksApi.update(project.id, task.id, input);
      upsertTask(r.task);
      r.shifted.forEach(upsertTask);
      if (r.submittedInstead) setError(null);
      return r;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
      return null;
    }
  };

  const act = async (action: Parameters<typeof tasksApi.action>[2], extra?: { reason?: string; dueDate?: string | null }) => {
    setBusy(true);
    setError(null);
    try {
      upsertTask(await tasksApi.action(project.id, task.id, action, extra));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не получилось');
    } finally {
      setBusy(false);
    }
  };

  const changeDue = (v: string | null) => {
    const hasChain = dependentsOf(projectTasks, task.id).length > 0 && !!task.dueDate && !!v;
    if (hasChain || !perm.controller) setShift(v);
    else void patch({ dueDate: v });
  };

  const members = project.memberIds;
  const subtasksDone = task.subtasks.filter((s) => s.done).length;
  const deadlineLate = task.deadline && isOpen(task) && task.deadline < today;
  // Перекрёстная проверка дат — только предупреждения, сохранить можно любые даты.
  const issues = dateIssues(task, byId);
  const downstream = isOpen(task) ? dependentIssues(task, projectTasks, byId) : [];
  const keyOf = (t: Task) => taskKey(project, t);
  const startLevel = worstLevel(issues.filter((i) => i.kind === 'overlap' || i.kind === 'range'));
  const dueLevel = worstLevel(issues.filter((i) => i.kind !== 'overlap'));
  /** «Поставить после ПЕР-4»: начало — на следующий день после её срока, длительность сохраняется. */
  const fixAfter = (i: DateIssue) => {
    const b = i.other;
    if (!b?.dueDate) return;
    const newStart = addDays(b.dueDate, 1);
    const from = task.startDate ?? task.dueDate;
    const delta = from ? diffDays(newStart, from) : 0;
    const newDue = task.dueDate ? addDays(task.dueDate, delta) : null;
    const hasChain = dependentsOf(projectTasks, task.id).length > 0;
    void patch({ startDate: newStart, ...(newDue && newDue !== task.dueDate ? { dueDate: newDue, shiftChain: hasChain } : {}) });
  };

  return (
    <>
      <div className="fixed inset-0 z-40 hidden bg-black/20 md:block" onClick={onClose} aria-hidden />
      <section
        role="dialog"
        aria-label={`Задача ${taskKey(project, task)}`}
        className="fixed inset-0 z-40 flex flex-col bg-surface-raised shadow-dialog md:inset-y-0 md:left-auto md:right-0 md:w-[min(680px,100vw)] md:border-l md:border-line/[0.08]"
        data-no-swipe-back
      >
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line/[0.06] px-2 md:px-4" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
          <button type="button" onClick={onClose} className="btn-icon md:hidden" aria-label="Назад">
            <ChevronLeft size={20} />
          </button>
          <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-ink-muted">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: projectColor(project) }} />
            <span className="truncate">{project.name} · {taskKey(project, task)}</span>
          </span>
          <button
            type="button"
            className="btn-icon"
            title="Скопировать ссылку"
            aria-label="Скопировать ссылку"
            onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}/tasks?project=${project.id}&task=${task.id}`)}
          >
            <Link2 size={16} />
          </button>
          {perm.controller && (
            <button type="button" className={clsx('btn-icon', confirmDelete && 'text-danger')} title={confirmDelete ? 'Нажмите ещё раз, чтобы удалить' : 'Удалить задачу'} aria-label="Удалить задачу" onClick={async () => {
              if (!confirmDelete) return setConfirmDelete(true);
              await tasksApi.remove(project.id, task.id).then(() => {
                removeTask(task.id);
                onClose();
              }).catch((err) => setError(err instanceof Error ? err.message : 'Не удалось удалить'));
            }}>
              <Trash2 size={16} />
            </button>
          )}
          <button type="button" onClick={onClose} className="btn-icon hidden md:inline-flex" aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-5 px-4 py-4 md:px-6">
            {/* Заголовок и статус */}
            <div className="flex flex-col gap-3">
              <textarea
                value={title}
                rows={1}
                readOnly={!perm.edit}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => title.trim() && title.trim() !== task.title && void patch({ title: title.trim() })}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
                className="w-full resize-none bg-transparent text-[21px] font-bold leading-tight tracking-tight text-ink outline-none [field-sizing:content]"
                aria-label="Название задачи"
              />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={task.status}
                  disabled={!perm.edit}
                  onChange={(e) => void patch({ status: e.target.value as Task['status'] })}
                  className={clsx('h-8 rounded-md border-0 px-2.5 text-[13px] font-medium outline-none', STATUS_META[task.status].chip)}
                  aria-label="Статус"
                >
                  {(Object.keys(STATUS_META) as Task['status'][]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_META[s].label}
                    </option>
                  ))}
                </select>
                {perm.isAssignee && task.authorId !== meId && (task.status === 'new' || task.status === 'in_progress') && task.acceptance !== 'pending' && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => void act('submit')}>
                    <Check size={14} />
                    Сдать на проверку
                  </button>
                )}
                {(perm.isAssignee || perm.controller) && task.authorId === task.assigneeId && isOpen(task) && task.status !== 'review' && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => void act('submit')}>
                    <Check size={14} />
                    Готово
                  </button>
                )}
                {task.status === 'done' && perm.edit && (
                  <button type="button" className="btn-ghost" disabled={busy} onClick={() => void act('reopen')}>
                    <RotateCcw size={14} />
                    Открыть снова
                  </button>
                )}
                <span className="ml-auto text-xs text-ink-faint">
                  {name(task.authorId)} · {fmtTime(task.createdAt)}
                </span>
              </div>
            </div>

            {/* Поручение: принять / отклонить */}
            {perm.isAssignee && task.acceptance === 'pending' && task.authorId !== meId && (
              <div className="flex flex-col gap-2.5 rounded-xl border border-accent/40 bg-accent-soft/60 p-3.5">
                <p className="text-sm">
                  <b>{name(task.authorId)}</b> поручил(а) вам эту задачу{task.dueDate ? ` — срок ${fmtDate(task.dueDate, true)}` : ''}.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn bg-[#16A34A] text-white hover:bg-[#15803D]" disabled={busy} onClick={() => void act('accept')}>
                    Принять
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setReasonFor('decline')}>
                    Отклонить
                  </button>
                </div>
              </div>
            )}
            {task.acceptance === 'declined' && (
              <div className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/5 p-3.5 text-sm">
                <CircleSlash size={16} className="mt-0.5 shrink-0 text-danger" />
                <span>
                  <b>{name(task.assigneeId)}</b> отклонил(а) поручение{task.declineReason ? `: «${task.declineReason}»` : ''}.
                  {perm.controller && ' Назначьте другого ответственного или обсудите ниже.'}
                </span>
              </div>
            )}

            {/* Проверка работы */}
            {task.status === 'review' && (
              <div className={clsx('flex flex-col gap-2.5 rounded-xl border p-3.5', perm.controller ? 'border-[#F5D58A] bg-[#FFFBEB] dark:border-[#5A4316] dark:bg-[#2A2110]' : 'border-line/10 bg-surface-hover')}>
                <p className="text-sm">
                  {perm.controller ? (
                    <>
                      <b>{name(task.assigneeId)}</b> сдал(а) работу. Примите её или верните с комментарием.
                    </>
                  ) : (
                    <>Работа на проверке у {name(task.authorId)}.</>
                  )}
                </p>
                {perm.controller && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn bg-[#16A34A] text-white hover:bg-[#15803D]" disabled={busy} onClick={() => void act('approve')}>
                      Принять работу
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => setReasonFor('return')}>
                      Вернуть на доработку
                    </button>
                  </div>
                )}
              </div>
            )}

            {blockers.length > 0 && isOpen(task) && (
              <div className="flex items-start gap-2.5 rounded-xl bg-danger/5 p-3 text-sm text-danger">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>
                  Заблокирована: ждёт {blockers.map((b) => (b.hidden ? `${taskKey(project, b)} (закрытая задача)` : `${taskKey(project, b)} «${b.title}»`)).join(', ')}. Когда {blockers.length > 1 ? 'они будут готовы' : 'она будет готова'}, исполнитель получит уведомление.
                </span>
              </div>
            )}

            {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

            {/* Поля */}
            <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-[13.5px] sm:grid-cols-[140px_minmax(0,1fr)]">
              <span className="text-ink-muted">Постановщик</span>
              <span className="flex items-center gap-2">
                <Avatar avatarUrl={people.get(task.authorId)?.avatarUrl} displayName={name(task.authorId)} size="xs" />
                {name(task.authorId)}
              </span>
              <span className="text-ink-muted">Ответственный</span>
              <PersonPicker
                people={people}
                value={task.assigneeId ? [task.assigneeId] : []}
                onChange={(ids) => void patch({ assigneeId: ids[0] ?? null })}
                preferIds={members}
                disabled={!perm.controller}
                placeholder="Назначить"
                allowNone
              />
              <span className="text-ink-muted">Соисполнители</span>
              <PersonPicker people={people} value={task.coAssigneeIds} onChange={(ids) => void patch({ coAssigneeIds: ids })} multiple preferIds={members} excludeIds={task.assigneeId ? [task.assigneeId] : []} disabled={!perm.edit} placeholder="Добавить" />
              <span className="text-ink-muted">Наблюдатели</span>
              <PersonPicker people={people} value={task.watcherIds} onChange={(ids) => void patch({ watcherIds: ids })} multiple preferIds={members} disabled={!perm.edit} placeholder="Добавить" />
              <span className="text-ink-muted">Начало</span>
              <DateField label="Начало" value={task.startDate} onChange={(v) => void patch({ startDate: v })} disabled={!perm.edit} tone={startLevel ? ISSUE_FIELD_TONE[startLevel] : undefined} />
              <span className="text-ink-muted">Срок</span>
              <span className="flex flex-wrap items-center gap-2">
                <DateField label="Срок" value={task.dueDate} onChange={changeDue} disabled={!perm.edit} tone={dueLevel ? ISSUE_FIELD_TONE[dueLevel] : undefined} />
                {task.dueDate && isOpen(task) && <span className={clsx('text-xs', task.dueDate < today ? 'text-danger' : 'text-ink-muted')}>{relDay(task.dueDate, today)}</span>}
              </span>
              <span className="text-ink-muted">Дедлайн</span>
              <span className="flex flex-wrap items-center gap-2">
                <DateField label="Дедлайн" value={task.deadline} onChange={(v) => void patch({ deadline: v })} disabled={!perm.controller} tone={deadlineLate ? 'border-danger/60 text-danger' : undefined} />
                <span className="text-xs text-ink-muted">{perm.controller ? 'напомним за 2 дня' : 'меняет постановщик'}</span>
              </span>
              {(issues.length > 0 || downstream.length > 0) && (
                <div className="col-span-2">
                  <DateIssuesPanel
                    issues={issues}
                    downstream={downstream}
                    keyOf={keyOf}
                    onOpenTask={onOpenTask}
                    onFix={perm.controller ? fixAfter : undefined}
                  />
                </div>
              )}
              <span className="self-start pt-1 text-ink-muted">Ждёт</span>
              <div className="flex flex-col items-start gap-1">
                {task.dependsOn.map((id) => {
                  const d = byId.get(id);
                  if (!d) return null;
                  return (
                    <span key={id} className="flex max-w-full items-center gap-2">
                      <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATUS_META[d.status].dot)} />
                      {d.hidden ? (
                        <span className="flex min-w-0 items-center gap-1.5 text-ink-muted" title="Задача, в которой вы не участвуете: видны только номер, статус и срок">
                          <Lock size={12} className="shrink-0" />
                          <span className="truncate">{taskKey(project, d)} · закрытая задача</span>
                        </span>
                      ) : (
                        <button type="button" onClick={() => onOpenTask(d)} className="truncate text-left hover:text-accent">
                          {taskKey(project, d)} {d.title}
                        </button>
                      )}
                      <span className="shrink-0 text-xs text-ink-faint">{STATUS_META[d.status].label.toLowerCase()}</span>
                      {d.dueDate && isOpen(d) && <span className="shrink-0 text-xs text-ink-faint">до {fmtDate(d.dueDate)}</span>}
                      <IssueMark level={worstLevel(issues.filter((i) => i.other?.id === d.id))} />
                      {perm.edit && (
                        <button type="button" className="btn-icon-sm" aria-label="Убрать связь" onClick={() => void patch({ dependsOn: task.dependsOn.filter((x) => x !== id) })}>
                          <X size={12} />
                        </button>
                      )}
                    </span>
                  );
                })}
                {perm.edit && (
                  <div className="relative">
                    <button type="button" className="text-[13px] font-medium text-accent hover:underline" onClick={() => setDepPicker((v) => !v)}>
                      + Задача, которую ждёт эта
                    </button>
                    {depPicker && (
                      <DependencyPicker
                        tasks={projectTasks.filter((t) => !t.hidden && t.id !== task.id && !task.dependsOn.includes(t.id) && !downstreamIds.has(t.id))}
                        project={project}
                        self={task}
                        onClose={() => setDepPicker(false)}
                        onPick={(t) => {
                          setDepPicker(false);
                          void patch({ dependsOn: [...task.dependsOn, t.id] });
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
              {blocks.length > 0 && (
                <>
                  <span className="self-start pt-0.5 text-ink-muted">Блокирует</span>
                  <div className="flex flex-col items-start gap-1">
                    {blocks.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        disabled={b.hidden}
                        title={b.hidden ? 'Задача, в которой вы не участвуете: видны только номер, статус и срок' : undefined}
                        onClick={() => onOpenTask(b)}
                        className="flex max-w-full items-center gap-2 text-left enabled:hover:text-accent disabled:text-ink-muted"
                      >
                        <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATUS_META[b.status].dot)} />
                        {b.hidden && <Lock size={12} className="shrink-0" />}
                        <span className="truncate">{taskKey(project, b)} {b.hidden ? '· закрытая задача' : b.title}</span>
                        {(b.startDate ?? b.dueDate) && isOpen(b) && <span className="shrink-0 text-xs text-ink-faint">с {fmtDate(b.startDate ?? b.dueDate)}</span>}
                        <IssueMark level={worstLevel(downstream.filter((x) => x.task.id === b.id).map((x) => x.issue))} />
                      </button>
                    ))}
                  </div>
                </>
              )}
              <span className="self-start pt-1 text-ink-muted">Документы</span>
              <div className="flex min-w-0 flex-col gap-1.5">
                {task.pageRefs.map((r) => (
                  <div key={`${r.ownerId}/${r.pageId}`} className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <PageRefCard ownerId={r.ownerId} projectId={r.projectId} pageId={r.pageId} />
                      {r.shared ? (
                        <span className="mt-0.5 block text-[11.5px] text-ink-faint">Открыт участникам задачи: исполнителям — правка, наблюдателям — чтение</span>
                      ) : r.ownerId === meId || role === 'Admin' ? (
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[#B45309] dark:text-[#FCD58A]">
                          Участники задачи могут не иметь доступа
                          <button type="button" className="font-medium text-accent hover:underline" onClick={() => void patch({ shareRefs: [r] })}>
                            Открыть участникам
                          </button>
                        </span>
                      ) : (
                        <span className="mt-0.5 block text-[11.5px] text-[#B45309] dark:text-[#FCD58A]">Доступ участникам не выдан — открыть документ другим может только его владелец</span>
                      )}
                    </div>
                    {perm.edit && (
                      <button type="button" className="btn-icon-sm" aria-label="Отвязать документ" onClick={() => void patch({ pageRefs: task.pageRefs.filter((x) => x.pageId !== r.pageId) })}>
                        <X size={12} />
                      </button>
                    )}
                  </div>
                ))}
                {perm.edit && (
                  <button type="button" className="inline-flex items-center gap-1.5 self-start text-[13px] font-medium text-accent hover:underline" onClick={() => setPagePicker(true)}>
                    <FileSymlink size={13} />
                    Привязать документ
                  </button>
                )}
              </div>
              {task.source && (
                <>
                  <span className="text-ink-muted">Из чата</span>
                  <a href={`/chat?open=${task.source.chatId}`} className="inline-flex items-center gap-1.5 text-[13px] text-accent hover:underline">
                    <MessageSquare size={13} />
                    Открыть переписку
                  </a>
                </>
              )}
            </div>

            {/* Описание */}
            <div className="flex flex-col gap-1.5">
              <h3 className="text-[13px] font-semibold text-ink-muted">Описание</h3>
              {editDesc ? (
                <textarea
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  onBlur={() => {
                    setEditDesc(false);
                    if (desc !== task.description) void patch({ description: desc });
                  }}
                  className="input min-h-[120px] py-2 [field-sizing:content]"
                  placeholder="Подробности, ссылки, критерии готовности. Поддерживается Markdown."
                />
              ) : task.description ? (
                <div
                  role={perm.edit ? 'button' : undefined}
                  tabIndex={perm.edit ? 0 : undefined}
                  onClick={() => perm.edit && setEditDesc(true)}
                  onKeyDown={(e) => perm.edit && e.key === 'Enter' && setEditDesc(true)}
                  className={clsx('chat-message-body whitespace-pre-wrap break-words rounded-md text-[14px] leading-relaxed', perm.edit && '-mx-2 cursor-text px-2 py-1 hover:bg-surface-hover')}
                  dangerouslySetInnerHTML={{ __html: chatMarkdownToHtml(task.description) }}
                />
              ) : perm.edit ? (
                <button type="button" onClick={() => setEditDesc(true)} className="self-start text-sm text-ink-faint hover:text-ink">
                  Добавить описание…
                </button>
              ) : (
                <p className="text-sm text-ink-faint">Без описания</p>
              )}
            </div>

            {/* Подзадачи */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <h3 className="text-[13px] font-semibold text-ink-muted">Подзадачи</h3>
                {task.subtasks.length > 0 && (
                  <>
                    <span className="text-xs text-ink-muted">{subtasksDone} из {task.subtasks.length}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
                      <span className="block h-full rounded-full bg-accent" style={{ width: `${(subtasksDone / task.subtasks.length) * 100}%` }} />
                    </span>
                  </>
                )}
              </div>
              {task.subtasks.map((s) => (
                <div key={s.id} className="group flex min-h-[38px] items-center gap-2.5 rounded-md px-1 hover:bg-surface-hover">
                  <input
                    type="checkbox"
                    checked={s.done}
                    disabled={!perm.edit}
                    onChange={() => void patch({ subtasks: task.subtasks.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)) })}
                    className="h-[17px] w-[17px] shrink-0 cursor-pointer accent-[rgb(var(--accent))]"
                    aria-label={s.title}
                  />
                  <span className={clsx('min-w-0 flex-1 text-[14px]', s.done && 'text-ink-faint line-through')}>{s.title}</span>
                  {perm.edit ? (
                    <>
                      <input
                        type="date"
                        value={s.dueDate ?? ''}
                        onChange={(e) => void patch({ subtasks: task.subtasks.map((x) => (x.id === s.id ? { ...x, dueDate: e.target.value || null } : x)) })}
                        className="h-7 w-[118px] rounded border border-transparent bg-transparent px-1 text-xs text-ink-muted hover:border-line/15"
                        aria-label={`Срок подзадачи «${s.title}»`}
                      />
                      <select
                        value={s.assigneeId ?? ''}
                        onChange={(e) => void patch({ subtasks: task.subtasks.map((x) => (x.id === s.id ? { ...x, assigneeId: e.target.value || null } : x)) })}
                        className="h-7 max-w-[120px] rounded border border-transparent bg-transparent text-xs text-ink-muted hover:border-line/15"
                        aria-label={`Исполнитель подзадачи «${s.title}»`}
                      >
                        <option value="">— кто</option>
                        {members.map((id) => (
                          <option key={id} value={id}>
                            {name(id)}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="btn-icon-sm opacity-0 group-hover:opacity-100" aria-label="Удалить подзадачу" onClick={() => void patch({ subtasks: task.subtasks.filter((x) => x.id !== s.id) })}>
                        <X size={12} />
                      </button>
                    </>
                  ) : (
                    <>
                      {s.dueDate && <span className="text-xs text-ink-muted">{fmtDate(s.dueDate)}</span>}
                      {s.assigneeId && <Avatar avatarUrl={people.get(s.assigneeId)?.avatarUrl} displayName={name(s.assigneeId)} size="xs" />}
                    </>
                  )}
                </div>
              ))}
              {perm.edit && (
                <form
                  className="flex items-center gap-2 px-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const t = newSub.trim();
                    if (!t) return;
                    setNewSub('');
                    void patch({ subtasks: [...task.subtasks, { id: Math.random().toString(36).slice(2, 12), title: t, done: false, assigneeId: null, dueDate: null }] });
                  }}
                >
                  <Plus size={15} className="shrink-0 text-ink-faint" />
                  <input value={newSub} onChange={(e) => setNewSub(e.target.value)} placeholder="Добавить подзадачу" className="h-9 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-faint" />
                </form>
              )}
            </div>

            <Discussion key={task.id} project={project} task={task} activity={activity} people={people} meId={meId} canModerate={perm.manage} name={name} />
          </div>
        </div>

        <CommentComposer project={project} task={task} people={people} meId={meId} />
      </section>

      {shift !== undefined && (
        <ShiftDialog
          task={task}
          project={project}
          tasks={projectTasks}
          newDue={shift}
          needReason={!perm.controller}
          onClose={() => setShift(undefined)}
          onDone={() => setShift(undefined)}
        />
      )}
      {reasonFor === 'decline' && (
        <ReasonDialog
          title="Отклонить поручение"
          label={`Почему? Увидит ${name(task.authorId)}`}
          placeholder="Например: занят переездом до 10 ноября"
          confirm="Отклонить"
          onClose={() => setReasonFor(null)}
          onSubmit={async (reason) => {
            upsertTask(await tasksApi.action(project.id, task.id, 'decline', { reason }));
            setReasonFor(null);
          }}
        />
      )}
      {reasonFor === 'return' && (
        <ReasonDialog
          title="Вернуть на доработку"
          label={`Что поправить? Увидит ${name(task.assigneeId)}`}
          placeholder="Например: в разделе 4 не хватает порядка выдачи гостевых пропусков"
          confirm="Вернуть"
          withDate={{ label: 'Новый срок (необязательно)', value: task.dueDate }}
          onClose={() => setReasonFor(null)}
          onSubmit={async (reason, date) => {
            upsertTask(await tasksApi.action(project.id, task.id, 'return', { reason, dueDate: date !== task.dueDate ? date : undefined }));
            setReasonFor(null);
          }}
        />
      )}
      {pagePicker && (
        <PagePickerDialog
          currentUserId={meId}
          onClose={() => setPagePicker(false)}
          onPick={(page) => {
            setPagePicker(false);
            if (!task.pageRefs.some((r) => r.pageId === page.pageId)) void patch({ pageRefs: [...task.pageRefs, page] });
          }}
        />
      )}
    </>
  );
}

/** Что будет с датами, если эта задача начнёт ждать `candidate`. */
function PickerIssue({ self, candidate }: { self: Task; candidate: Task }) {
  const probe = { ...self, dependsOn: [candidate.id] };
  const level = worstLevel(dateIssues(probe, new Map([[candidate.id, candidate]])).filter((i) => i.other));
  if (!level) return candidate.dueDate ? <span className="shrink-0 text-xs text-ink-faint">до {fmtDate(candidate.dueDate)}</span> : null;
  return (
    <span className={clsx('flex shrink-0 items-center gap-1 text-xs', level === 'error' ? 'text-danger' : 'text-[#B45309] dark:text-[#FCD58A]')} title="Даты пересекутся">
      <AlertTriangle size={12} />
      до {fmtDate(candidate.dueDate)}
    </span>
  );
}

function DependencyPicker({
  tasks,
  project,
  self,
  onPick,
  onClose,
}: {
  tasks: Task[];
  project: TaskProject;
  /** Задача, к которой добавляем связь — чтобы заранее показать, пересекутся ли даты. */
  self: Task;
  onPick: (t: Task) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);
  const needle = q.trim().toLowerCase();
  const list = tasks.filter((t) => !needle || t.title.toLowerCase().includes(needle) || `${project.key}-${t.number}`.toLowerCase().includes(needle)).slice(0, 40);
  return (
    <div ref={ref} className="popover absolute left-0 top-full z-40 mt-1 w-80 p-1.5">
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти задачу проекта" className="input mb-1 h-8" />
      <div className="max-h-64 overflow-y-auto">
        {list.map((t) => (
          <button key={t.id} type="button" className="menu-item h-9" onClick={() => onPick(t)}>
            <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATUS_META[t.status].dot)} />
            <span className="shrink-0 text-xs text-ink-muted">{project.key}-{t.number}</span>
            <span className="min-w-0 flex-1 truncate text-left">{t.title}</span>
            <PickerIssue self={self} candidate={t} />
          </button>
        ))}
        {!list.length && <p className="px-2 py-3 text-sm text-ink-faint">Нет подходящих задач</p>}
      </div>
    </div>
  );
}

function Discussion({
  project,
  task,
  activity,
  people,
  meId,
  canModerate,
  name,
}: {
  project: TaskProject;
  task: Task;
  activity: TaskActivity[] | null;
  people: Map<string, Person>;
  meId: string;
  canModerate: boolean;
  name: (id: string | null | undefined) => string;
}) {
  const [tab, setTab] = useState<'all' | 'comments'>('all');
  const items = (activity ?? []).filter((a) => tab === 'all' || a.kind === 'comment');
  const comments = (activity ?? []).filter((a) => a.kind === 'comment').length;
  const endRef = useRef<HTMLDivElement>(null);
  // Прокручиваем к концу только когда при открытой задаче появился новый
  // комментарий. При открытии карточка начинается с заголовка, а записи
  // истории (сменили дату, статус) не уводят от поля, которое правят.
  const seenRef = useRef<number | null>(null);
  useEffect(() => {
    if (activity == null) {
      seenRef.current = null;
      return;
    }
    if (seenRef.current != null && comments > seenRef.current) endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    seenRef.current = comments;
  }, [comments, activity == null]);

  return (
    <div className="flex flex-col gap-3 pb-2">
      <div className="flex gap-4 border-b border-line/[0.07] text-[13.5px]">
        <button type="button" onClick={() => setTab('all')} className={clsx('-mb-px border-b-2 pb-1.5', tab === 'all' ? 'border-accent font-semibold' : 'border-transparent text-ink-muted')}>
          Обсуждение и история
        </button>
        <button type="button" onClick={() => setTab('comments')} className={clsx('-mb-px border-b-2 pb-1.5', tab === 'comments' ? 'border-accent font-semibold' : 'border-transparent text-ink-muted')}>
          Только комментарии · {comments}
        </button>
      </div>
      {!activity && <Loader2 size={16} className="animate-spin text-ink-faint" />}
      {items.map((a) =>
        a.kind === 'event' ? (
          <p key={a.id} className="flex items-start gap-2 pl-1 text-[12.5px] text-ink-muted">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-line/30" />
            <span>
              <b className="font-medium text-ink">{name(a.authorId)}</b> {eventText(a, name, () => '')} · {fmtTime(a.createdAt)}
            </span>
          </p>
        ) : (
          <div key={a.id} className="group flex gap-2.5">
            <Avatar avatarUrl={people.get(a.authorId)?.avatarUrl} displayName={name(a.authorId)} size="sm" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs">
                <b className="font-semibold">{name(a.authorId)}</b> <span className="text-ink-muted">{fmtTime(a.createdAt)}{a.editedAt ? ' · изменено' : ''}</span>
                {(a.authorId === meId || canModerate) && (
                  <button
                    type="button"
                    className="ml-2 text-ink-faint opacity-0 hover:text-danger group-hover:opacity-100"
                    onClick={() => void tasksApi.deleteComment(project.id, task.id, a.id).catch(() => undefined)}
                  >
                    удалить
                  </button>
                )}
              </span>
              {a.text && <div className="chat-message-body self-start whitespace-pre-wrap break-words rounded-xl bg-surface-hover px-3 py-2 text-[14px] leading-relaxed" dangerouslySetInnerHTML={{ __html: highlightMentions(chatMarkdownToHtml(a.text), people) }} />}
              {a.attachment && <div className="self-start"><ChatAttachmentView attachment={a.attachment} isMine={a.authorId === meId} /></div>}
            </div>
          </div>
        ),
      )}
      {activity && !items.length && <p className="text-sm text-ink-faint">Пока тихо. Напишите первым — участники получат уведомление.</p>}
      <div ref={endRef} />
    </div>
  );
}

function highlightMentions(html: string, people: Map<string, Person>): string {
  let out = html;
  for (const p of people.values()) {
    const n = p.displayName.replace(/[&<>"]/g, '');
    if (!n) continue;
    out = out.split(`@${n}`).join(`<span class="rounded bg-accent-soft px-0.5 font-medium text-accent-ink">@${n}</span>`);
  }
  return out;
}

function CommentComposer({ project, task, people, meId }: { project: TaskProject; task: Task; people: Map<string, Person>; meId: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [filePicker, setFilePicker] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [recordable, setRecordable] = useState(false);
  useEffect(() => setRecordable(canRecord()), []);
  // Упомянуть можно любого сотрудника: кто задачу не видит, станет наблюдателем (сервер).
  const inTask = new Set([task.authorId, task.assigneeId, ...task.coAssigneeIds, ...task.watcherIds].filter((x): x is string => !!x));
  const rank = (id: string) => (inTask.has(id) ? 0 : project.memberIds.includes(id) ? 1 : 2);
  const members = [...people.values()]
    .filter((p) => !p.dismissed && p.id !== meId)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.displayName.localeCompare(b.displayName, 'ru'));

  const send = async (attachment?: Parameters<typeof tasksApi.comment>[2]['attachment']) => {
    const t = text.trim();
    if (!t && !attachment) return;
    setBusy(true);
    setError(null);
    try {
      const mentionIds = members.filter((p) => t.includes(`@${p.displayName}`)).map((p) => p.id);
      await tasksApi.comment(project.id, task.id, { text: attachment ? '' : t, mentionIds, attachment: attachment ?? null });
      if (!attachment) setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить');
    } finally {
      setBusy(false);
    }
  };

  const sendRecording = async (r: RecordingResult) => {
    let uploaded: string | null = null;
    try {
      const f = await filesApi.upload(r.file);
      uploaded = f.fileName;
      await send({ url: f.url, fileName: f.originalName, mimeType: f.mimeType, size: f.size, kind: r.kind, duration: r.duration, waveform: r.waveform });
    } catch {
      if (uploaded) void filesApi.remove(uploaded).catch(() => undefined);
      setError('Не удалось отправить запись');
    }
  };

  return (
    <div className="shrink-0 border-t border-line/[0.06] px-3 pb-[max(var(--safe-bottom),12px)] pt-2.5 md:px-5">
      {error && <p className="mb-1.5 text-xs text-danger">{error}</p>}
      <div ref={rowRef} className="relative flex items-end gap-1 rounded-xl border border-line/[0.1] bg-surface p-1.5 focus-within:border-accent/50">
        <button type="button" className="btn-icon" aria-label="Прикрепить файл" onClick={() => setFilePicker(true)}>
          <Paperclip size={16} />
        </button>
        <div className="relative">
          <button type="button" className="btn-icon" aria-label="Упомянуть коллегу" onClick={() => setMentionOpen((v) => !v)}>
            <AtSign size={16} />
          </button>
          {mentionOpen && (
            <div className="popover absolute bottom-full left-0 z-40 mb-2 max-h-60 w-72 overflow-y-auto p-1">
              {members.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="menu-item h-9"
                  onClick={() => {
                    setText((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}@${p.displayName} `);
                    setMentionOpen(false);
                  }}
                >
                  <Avatar avatarUrl={p.avatarUrl} displayName={p.displayName} size="xs" />
                  <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
                  {!inTask.has(p.id) && <span className="shrink-0 text-[11px] text-ink-faint">станет наблюдателем</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder="Комментарий… @ — упомянуть"
          className="max-h-40 min-h-[32px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-sm outline-none [field-sizing:content] placeholder:text-ink-faint"
          aria-label="Комментарий"
        />
        {!text.trim() && recordable ? (
          <MediaRecordButton anchorRef={rowRef} onRecorded={sendRecording} />
        ) : (
          <button type="button" className="btn-primary h-11 w-11 shrink-0 rounded-full px-0 md:h-8 md:w-8 md:rounded-lg" disabled={busy || !text.trim()} onClick={() => void send()} aria-label="Отправить">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        )}
      </div>
      {filePicker && (
        <FilePickerDialog
          onClose={() => setFilePicker(false)}
          onPick={(f: UserFileInfo) => {
            setFilePicker(false);
            void send({ url: f.url, fileName: f.originalName, mimeType: f.mimeType, size: f.size });
          }}
        />
      )}
    </div>
  );
}


function IssueMark({ level }: { level: 'warn' | 'error' | null }) {
  if (!level) return null;
  return <AlertTriangle size={13} className={clsx('shrink-0', level === 'error' ? 'text-danger' : 'text-[#D97706]')} aria-label="Даты пересекаются" />;
}

/**
 * Нелогичные даты: свои (начало до окончания того, что ждём; срок позже
 * дедлайна…) и у задач, которые ждут эту. Это подсказка, а не запрет —
 * зависимую работу можно начинать заранее.
 */
function DateIssuesPanel({
  issues,
  downstream,
  keyOf,
  onOpenTask,
  onFix,
}: {
  issues: DateIssue[];
  downstream: { task: Task; issue: DateIssue }[];
  keyOf: (t: Task) => string;
  onOpenTask: (t: Task) => void;
  onFix?: (i: DateIssue) => void;
}) {
  const level = worstLevel([...issues, ...downstream.map((x) => x.issue)]);
  return (
    <div
      role="status"
      className={clsx(
        'flex flex-col gap-2 rounded-xl px-3.5 py-3 text-[13px]',
        level === 'error' ? 'bg-danger/[0.07]' : 'bg-[#FEF3C7]/70 dark:bg-[#4A3612]/60',
      )}
    >
      <span className={clsx('flex items-center gap-1.5 font-semibold', level === 'error' ? 'text-danger' : 'text-[#92400E] dark:text-[#FCD58A]')}>
        <AlertTriangle size={14} />
        Даты не сходятся
      </span>
      {issues.map((i, n) => (
        <div key={`s${n}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 flex-1">{describeDateIssue(i, keyOf)}</span>
          {i.other && !i.other.hidden && (
            <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => onOpenTask(i.other!)}>
              Открыть {keyOf(i.other)}
            </button>
          )}
          {onFix && i.other && (i.kind === 'overlap' || i.kind === 'order') && (
            <button type="button" className="btn-secondary h-7 px-2 text-xs" onClick={() => onFix(i)}>
              Начать после {keyOf(i.other)}
            </button>
          )}
        </div>
      ))}
      {downstream.map(({ task, issue }) => (
        <div key={`d${task.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 flex-1">
            {keyOf(task)} {task.hidden ? '(закрытая задача)' : `«${task.title}»`} ждёт эту задачу, но {issue.kind === 'order' ? `заканчивается не позже неё (${fmtDate(task.dueDate)})` : `начинается раньше — ${fmtDate(task.startDate)}`}
          </span>
          {!task.hidden && (
            <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => onOpenTask(task)}>
              Открыть {keyOf(task)}
            </button>
          )}
        </div>
      ))}
      <span className="text-xs text-ink-muted">
        Сохранить можно и так — начинать зависимую работу заранее нормально. Но если предыдущая задача задержится, эта тоже может сдвинуться.
      </span>
    </div>
  );
}
