'use client';

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react';
import { tasksApi, type Task, type TaskInput, type TaskProject } from '../../lib/api';
import { PROJECT_COLORS, addDays, diffDays, fmtDate, isOpen, projectColor, taskKey, todayIso, upsertProject, upsertTask, type Person } from '../../lib/tasks';
import { DateField, PersonPicker } from './TaskBits';

function DialogShell({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={clsx('dialog flex max-h-[90dvh] flex-col', wide ? 'max-w-2xl' : 'max-w-lg')}>
        <div className="flex items-center gap-2 border-b border-line/[0.06] px-5 py-3.5">
          <h2 className="flex-1 text-[15px] font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="btn-icon" aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line/[0.06] px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ новая задача

export interface NewTaskPrefill {
  title?: string;
  description?: string;
  projectId?: string | null;
  dueDate?: string | null;
  status?: Task['status'];
  source?: Task['source'];
  pageRefs?: Task['pageRefs'];
}

export function NewTaskDialog({
  projects,
  people,
  meId,
  prefill,
  onClose,
  onCreated,
}: {
  projects: TaskProject[];
  people: Map<string, Person>;
  meId: string;
  prefill?: NewTaskPrefill;
  onClose: () => void;
  onCreated: (task: Task, project: TaskProject) => void;
}) {
  const [projectId, setProjectId] = useState(prefill?.projectId ?? projects[0]?.id ?? '');
  const [title, setTitle] = useState(prefill?.title ?? '');
  const [description, setDescription] = useState(prefill?.description ?? '');
  const [assignee, setAssignee] = useState<string[]>([meId]);
  const [co, setCo] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState<string | null>(prefill?.dueDate ?? null);
  const [deadline, setDeadline] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(!projects.length);
  const project = projects.find((p) => p.id === projectId);

  const submit = async () => {
    if (!title.trim() || !project) return;
    setBusy(true);
    setError(null);
    try {
      const input: TaskInput = {
        title: title.trim(),
        description,
        assigneeId: assignee[0] ?? null,
        coAssigneeIds: co,
        dueDate,
        deadline,
        status: prefill?.status,
        source: prefill?.source ?? null,
        pageRefs: prefill?.pageRefs,
      };
      const task = await tasksApi.create(project.id, input);
      upsertTask(task);
      onCreated(task, project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать задачу');
      setBusy(false);
    }
  };

  if (creatingProject) {
    return (
      <ProjectDialog
        people={people}
        meId={meId}
        onClose={projects.length ? () => setCreatingProject(false) : onClose}
        onSaved={(p) => {
          setProjectId(p.id);
          setCreatingProject(false);
        }}
        hint={projects.length ? undefined : 'Задачи живут в проектах. Создайте первый — например, «Переезд офиса» или «Отдел продаж».'}
      />
    );
  }

  return (
    <DialogShell
      title="Новая задача"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn-primary" disabled={busy || !title.trim() || !project} onClick={() => void submit()}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {assignee[0] && assignee[0] !== meId ? 'Поручить' : 'Создать'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="label" htmlFor="nt-title">Что нужно сделать</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input id="nt-title" autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} placeholder="Например: заказать мебель" />
        </div>
        <div>
          <span className="label">Проект</span>
          <div className="flex flex-wrap gap-1.5">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProjectId(p.id)}
                className={clsx('inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px]', p.id === projectId ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line/10 hover:bg-surface-hover')}
              >
                <span className="h-2 w-2 rounded-[3px]" style={{ background: projectColor(p) }} />
                {p.name}
              </button>
            ))}
            <button type="button" onClick={() => setCreatingProject(true)} className="inline-flex h-8 items-center rounded-md border border-dashed border-line/25 px-2.5 text-[13px] text-ink-muted hover:text-ink">
              + Новый проект
            </button>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="label">Ответственный</span>
            <PersonPicker people={people} value={assignee} onChange={setAssignee} preferIds={project?.memberIds} placeholder="Назначить" allowNone />
          </div>
          <div>
            <span className="label">Соисполнители</span>
            <PersonPicker people={people} value={co} onChange={setCo} multiple preferIds={project?.memberIds} excludeIds={assignee} placeholder="Добавить" />
          </div>
          <div>
            <span className="label">Срок</span>
            <DateField label="Срок" value={dueDate} onChange={setDueDate} />
          </div>
          <div>
            <span className="label">Дедлайн</span>
            <DateField label="Дедлайн" value={deadline} onChange={setDeadline} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="nt-desc">Описание</label>
          <textarea id="nt-desc" className="input min-h-[96px] py-2" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Подробности, ссылки, критерии готовности" />
        </div>
        {dueDate && deadline && dueDate > deadline && (
          <p className="flex items-center gap-1.5 text-[13px] text-danger">
            <AlertTriangle size={13} />
            Срок позже дедлайна — задачу можно создать, но дедлайн будет пропущен.
          </p>
        )}
        {assignee[0] && assignee[0] !== meId && <p className="hint">{people.get(assignee[0])?.displayName ?? 'Исполнитель'} получит уведомление и сможет принять или отклонить поручение.</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </DialogShell>
  );
}

// ------------------------------------------------------------------ проект

export function ProjectDialog({
  project,
  people,
  meId,
  onClose,
  onSaved,
  onDeleted,
  canDelete,
  hint,
}: {
  project?: TaskProject;
  people: Map<string, Person>;
  meId: string;
  onClose: () => void;
  onSaved: (p: TaskProject) => void;
  onDeleted?: () => void;
  canDelete?: boolean;
  hint?: string;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState(project?.color ?? 'indigo');
  const [members, setMembers] = useState<string[]>(project?.memberIds.filter((x) => x !== meId) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const memberIds = [...new Set([meId, ...members])];
      const p = project ? await tasksApi.updateProject(project.id, { name: name.trim(), color, memberIds }) : await tasksApi.createProject({ name: name.trim(), color, memberIds });
      upsertProject(p);
      onSaved(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить проект');
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!project) return;
    setBusy(true);
    try {
      await tasksApi.deleteProject(project.id);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить проект');
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title={project ? 'Проект' : 'Новый проект'}
      onClose={onClose}
      footer={
        <>
          {project && canDelete && (
            <button type="button" className="btn-ghost mr-auto text-danger" onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))} disabled={busy}>
              <Trash2 size={14} />
              {confirmDelete ? 'Точно удалить со всеми задачами?' : 'Удалить проект'}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {project ? 'Сохранить' : 'Создать'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {hint && <p className="text-sm text-ink-muted">{hint}</p>}
        <div>
          <label className="label" htmlFor="pr-name">Название</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input id="pr-name" autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Переезд офиса" />
          {!project && <p className="hint mt-1.5">Из первых букв получится префикс номеров задач: «Переезд офиса» → ПЕР-1, ПЕР-2…</p>}
          {project && <p className="hint mt-1.5">Префикс задач: {project.key}</p>}
        </div>
        <div>
          <span className="label">Цвет</span>
          <div className="flex flex-wrap gap-2">
            {Object.entries(PROJECT_COLORS).map(([key, hex]) => (
              <button
                key={key}
                type="button"
                onClick={() => setColor(key)}
                aria-label={`Цвет ${key}`}
                aria-pressed={color === key}
                className={clsx('h-8 w-8 rounded-lg ring-offset-2 ring-offset-surface-raised', color === key && 'ring-2 ring-ink')}
                style={{ background: hex }}
              />
            ))}
          </div>
        </div>
        <div>
          <span className="label">Участники</span>
          <PersonPicker people={people} value={members} onChange={setMembers} multiple excludeIds={[meId]} placeholder="Добавить" />
          <p className="hint mt-1.5">Проект и его задачи видят только участники. Вы участвуете автоматически.</p>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </DialogShell>
  );
}

// ------------------------------------------------------------------ перенос срока и цепочка

/** Все задачи, которые прямо или через цепочку ждут `root`. */
export function dependentsOf(tasks: Task[], rootId: string): Task[] {
  const out: Task[] = [];
  const queue = [rootId];
  const seen = new Set<string>([rootId]);
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of tasks) {
      if (t.dependsOn.includes(id) && !seen.has(t.id)) {
        seen.add(t.id);
        out.push(t);
        queue.push(t.id);
      }
    }
  }
  return out.filter(isOpen);
}

/**
 * Перенос срока. Показывает, что поедет следом (задачи, которые ждут эту)
 * и какие дедлайны окажутся под угрозой; даёт выбрать — сдвинуть всю
 * цепочку или только эту задачу. Исполнитель обязан указать причину.
 */
export function ShiftDialog({
  task,
  project,
  tasks,
  newDue,
  needReason,
  onClose,
  onDone,
}: {
  task: Task;
  project: TaskProject;
  tasks: Task[];
  newDue: string | null;
  needReason: boolean;
  onClose: () => void;
  onDone: (t: Task, shifted: Task[]) => void;
}) {
  const deps = useMemo(() => dependentsOf(tasks, task.id), [tasks, task.id]);
  const delta = task.dueDate && newDue ? diffDays(newDue, task.dueDate) : 0;
  const [mode, setMode] = useState<'chain' | 'single'>(deps.length && delta ? 'chain' : 'single');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chain = mode === 'chain' && delta !== 0;
  const today = todayIso();

  const rows = deps.map((d) => {
    const due = chain && d.dueDate ? addDays(d.dueDate, delta) : d.dueDate;
    const start = chain && d.startDate ? addDays(d.startDate, delta) : d.startDate;
    const conflict = !chain && newDue && (d.startDate ?? d.dueDate) && newDue >= (d.startDate ?? d.dueDate)!;
    const missDeadline = d.deadline && due && due > d.deadline;
    return { d, due, start, conflict, missDeadline };
  });
  const selfMiss = newDue && task.deadline && newDue > task.deadline;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await tasksApi.update(project.id, task.id, { dueDate: newDue, shiftChain: chain, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      upsertTask(r.task);
      r.shifted.forEach(upsertTask);
      onDone(r.task, r.shifted);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось перенести срок');
      setBusy(false);
    }
  };

  return (
    <DialogShell
      wide
      title={`Перенести срок «${task.title}»${newDue ? ` на ${fmtDate(newDue, true)}` : ''}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn-primary" disabled={busy || (needReason && !reason.trim())} onClick={() => void save()}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {chain ? `Сдвинуть цепочку (${deps.length + 1})` : 'Перенести'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <table className="w-full text-left text-[13px]">
          <thead className="text-xs text-ink-muted">
            <tr>
              <th className="pb-2 font-medium">Задача</th>
              <th className="w-24 pb-2 font-medium">Было</th>
              <th className="w-24 pb-2 font-medium">Станет</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line/[0.06]">
              <td className="py-2 pr-2">
                <b className="font-medium">{taskKey(project, task)} {task.title}</b>
                {selfMiss && <span className="mt-0.5 flex items-center gap-1 text-xs text-danger"><AlertTriangle size={12} />позже дедлайна {fmtDate(task.deadline)}</span>}
              </td>
              <td className="py-2 text-ink-muted">{fmtDate(task.dueDate) || '—'}</td>
              <td className="py-2 font-medium">{fmtDate(newDue) || 'без срока'}</td>
            </tr>
            {rows.map(({ d, due, start, conflict, missDeadline }) => (
              <tr key={d.id} className="border-t border-line/[0.06]">
                <td className="py-2 pr-2">
                  <span>{taskKey(project, d)} {d.hidden ? '· закрытая задача' : d.title}</span>
                  <span className="block text-xs text-ink-muted">ждёт {d.dependsOn.includes(task.id) ? taskKey(project, task) : 'по цепочке'}</span>
                  {missDeadline && <span className="flex items-center gap-1 text-xs text-danger"><AlertTriangle size={12} />дедлайн {fmtDate(d.deadline)} будет пропущен</span>}
                  {conflict && <span className="flex items-center gap-1 text-xs text-danger"><AlertTriangle size={12} />начнётся раньше, чем закончится эта</span>}
                </td>
                <td className="py-2 text-ink-muted">{fmtDate(d.startDate) && `${fmtDate(d.startDate)} – `}{fmtDate(d.dueDate) || '—'}</td>
                <td className="py-2 font-medium">{fmtDate(start) && `${fmtDate(start)} – `}{fmtDate(due) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {deps.length > 0 && delta !== 0 && (
          <div className="flex flex-col gap-2">
            {(
              [
                ['chain', 'Сдвинуть всю цепочку', `Задачи, которые ждут эту, сдвинутся на ${Math.abs(delta)} дн. Их исполнители получат новые даты.`],
                ['single', 'Сдвинуть только эту задачу', 'Даты остальных не изменятся — следите за пересечениями.'],
              ] as const
            ).map(([id, title, text]) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                aria-pressed={mode === id}
                className={clsx('flex items-start gap-3 rounded-lg border px-3.5 py-3 text-left', mode === id ? 'border-accent bg-accent-soft/60' : 'border-line/10 hover:bg-surface-hover')}
              >
                <span className={clsx('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2', mode === id ? 'border-accent' : 'border-line/30')}>
                  {mode === id && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                </span>
                <span>
                  <b className="block font-medium">{title}</b>
                  <span className="text-xs text-ink-muted">{text}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        <div>
          <label className="label" htmlFor="sh-reason">
            Причина переноса {needReason ? '— обязательно, её увидит постановщик' : '(необязательно)'}
          </label>
          <input id="sh-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например: провайдер подключает только 7 ноября" />
        </div>
        {newDue && newDue < today && <p className="hint">Новый срок уже в прошлом — задача сразу станет просроченной.</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </DialogShell>
  );
}

// ------------------------------------------------------------------ причина (отклонить / вернуть)

export function ReasonDialog({
  title,
  label,
  placeholder,
  confirm,
  withDate,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  placeholder: string;
  confirm: string;
  withDate?: { label: string; value: string | null };
  onClose: () => void;
  onSubmit: (reason: string, date: string | null) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState<string | null>(withDate?.value ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <DialogShell
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(reason.trim(), date);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Не получилось');
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirm}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="label" htmlFor="rs-text">{label}</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <textarea id="rs-text" autoFocus className="input min-h-[80px] py-2" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} />
        </div>
        {withDate && (
          <div>
            <span className="label">{withDate.label}</span>
            <DateField label={withDate.label} value={date} onChange={setDate} />
          </div>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </DialogShell>
  );
}
