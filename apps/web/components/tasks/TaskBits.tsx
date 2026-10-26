'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Check, Clock, Flag, Lock, Plus, Search, X } from 'lucide-react';
import { Avatar } from '../Avatar';
import type { Task, TaskProject } from '../../lib/api';
import { ISSUE_TONE, STATUS_META, TONE_CHIP, dateIssues, describeDateIssue, dueTone, fmtDate, projectColor, relDay, worstLevel, type Person } from '../../lib/tasks';

export function StatusChip({ status, className }: { status: Task['status']; className?: string }) {
  const m = STATUS_META[status];
  return <span className={clsx('inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium', m.chip, className)}><span className={clsx('h-1.5 w-1.5 rounded-full', m.dot)} />{m.label}</span>;
}

export function DueChip({ task, today, withRel = false }: { task: Task; today: string; withRel?: boolean }) {
  if (!task.dueDate) return null;
  const tone = dueTone(task, today);
  const rel = withRel || tone !== 'normal' ? relDay(task.dueDate, today) : '';
  return (
    <span className={clsx('inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-xs font-medium', TONE_CHIP[tone])} title="Срок">
      <Clock size={12} />
      {tone === 'late' ? rel : `${fmtDate(task.dueDate)}${rel ? ` · ${rel}` : ''}`}
    </span>
  );
}

export function DeadlineChip({ task, today }: { task: Task; today: string }) {
  if (!task.deadline) return null;
  const late = task.status !== 'done' && task.deadline < today;
  return (
    <span
      className={clsx('inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-xs font-medium', late ? 'border-danger/60 text-danger' : 'border-line/20 text-ink-muted')}
      title="Дедлайн — нельзя пропустить"
    >
      <Flag size={11} />
      {fmtDate(task.deadline)}
    </span>
  );
}

/** Предупреждение о нелогичных датах (пересечение с задачей, которую ждёт, и т. п.). */
export function DateIssueChip({ task, byId, project }: { task: Task; byId: Map<string, Task>; project?: TaskProject }) {
  const issues = dateIssues(task, byId);
  const level = worstLevel(issues);
  if (!level) return null;
  const key = (t: Task) => (project ? `${project.key}-${t.number}` : t.title);
  const text = issues.map((i) => describeDateIssue(i, key)).join('\n');
  return (
    <span className={clsx('inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-xs font-medium', ISSUE_TONE[level])} title={text} aria-label={text}>
      <AlertTriangle size={11} />
      {level === 'error' ? 'Даты' : 'Пересечение'}
    </span>
  );
}

export function BlockedChip({ blockers, project }: { blockers: Task[]; project?: TaskProject }) {
  if (!blockers.length) return null;
  const first = blockers[0]!;
  return (
    <span className="inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-md bg-danger/10 px-1.5 text-xs font-medium text-danger" title={`Ждёт: ${blockers.map((b) => (b.hidden ? `${project ? `${project.key}-${b.number}` : ''} (закрытая задача)` : b.title)).join(', ')}`}>
      <Lock size={11} />
      Ждёт {project ? `${project.key}-${first.number}` : first.title}
      {blockers.length > 1 ? ` +${blockers.length - 1}` : ''}
    </span>
  );
}

export function ProjectTag({ project }: { project?: TaskProject }) {
  if (!project) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
      <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: projectColor(project) }} />
      <span className="truncate">{project.name}</span>
    </span>
  );
}

export function PeopleStack({ ids, people, size = 'xs', max = 4 }: { ids: (string | null)[]; people: Map<string, Person>; size?: 'xs' | 'sm'; max?: number }) {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return null;
  return (
    <span className="flex items-center">
      {list.slice(0, max).map((id, i) => {
        const p = people.get(id);
        return (
          <span key={id} className={clsx('rounded-full ring-2 ring-surface-raised', i > 0 && '-ml-1.5')} title={p?.displayName}>
            <Avatar avatarUrl={p?.avatarUrl} displayName={p?.displayName ?? '?'} size={size} />
          </span>
        );
      })}
      {list.length > max && <span className="ml-1 text-xs text-ink-muted">+{list.length - max}</span>}
    </span>
  );
}

/**
 * Выбор людей: один (ответственный) или несколько (соисполнители,
 * наблюдатели, участники проекта). Список — справочник сотрудников без
 * уволенных; участники проекта наверху.
 */
export function PersonPicker({
  people,
  value,
  onChange,
  multiple = false,
  preferIds = [],
  excludeIds = [],
  placeholder = 'Выбрать',
  disabled = false,
  allowNone = false,
}: {
  people: Map<string, Person>;
  value: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  preferIds?: string[];
  excludeIds?: string[];
  placeholder?: string;
  disabled?: boolean;
  allowNone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const options = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const prefer = new Set(preferIds);
    return [...people.values()]
      .filter((p) => !p.dismissed && !excludeIds.includes(p.id))
      .filter((p) => !needle || p.displayName.toLowerCase().includes(needle))
      .sort((a, b) => Number(prefer.has(b.id)) - Number(prefer.has(a.id)) || a.displayName.localeCompare(b.displayName, 'ru'));
  }, [people, q, preferIds, excludeIds]);

  const toggle = (id: string) => {
    if (multiple) onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
    else {
      onChange([id]);
      setOpen(false);
    }
  };

  return (
    <div ref={ref} className="relative flex min-w-0 flex-wrap items-center gap-1.5">
      {value.map((id) => {
        const p = people.get(id);
        return (
          <span key={id} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-surface-hover pl-0.5 pr-2 text-[13px]">
            <Avatar avatarUrl={p?.avatarUrl} displayName={p?.displayName ?? '?'} size="xs" />
            <span className="truncate">{p?.displayName ?? 'Неизвестно'}</span>
            {!disabled && (multiple || allowNone) && (
              <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} className="text-ink-faint hover:text-ink" aria-label={`Убрать ${p?.displayName ?? ''}`}>
                <X size={12} />
              </button>
            )}
          </span>
        );
      })}
      {!disabled && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={clsx(
            'inline-flex h-7 items-center gap-1 rounded-full text-[13px] text-ink-muted hover:text-ink',
            value.length && !multiple ? 'px-1.5' : 'border border-dashed border-line/25 px-2.5',
          )}
          aria-label={placeholder}
        >
          {value.length && !multiple ? 'Сменить' : (<><Plus size={12} />{placeholder}</>)}
        </button>
      )}
      {open && (
        <div className="popover absolute left-0 top-full z-40 mt-1 w-72 p-1.5">
          <label className="mb-1 flex h-9 items-center gap-2 rounded-md bg-surface-hover px-2.5">
            <Search size={14} className="text-ink-faint" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти сотрудника" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
          </label>
          <div className="max-h-64 overflow-y-auto">
            {options.map((p) => {
              const on = value.includes(p.id);
              return (
                <button key={p.id} type="button" onClick={() => toggle(p.id)} className="menu-item h-9">
                  <Avatar avatarUrl={p.avatarUrl} displayName={p.displayName} size="xs" />
                  <span className="flex-1 truncate">{p.displayName}</span>
                  {on && <Check size={14} className="text-accent" />}
                </button>
              );
            })}
            {!options.length && <p className="px-2 py-3 text-sm text-ink-faint">Никого не нашлось</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Поле даты с кнопкой очистки (нативный выбор даты — удобен и на телефоне). */
export function DateField({
  value,
  onChange,
  disabled,
  label,
  tone,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  label: string;
  tone?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="date"
        aria-label={label}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className={clsx('h-8 rounded-md border border-line/[0.12] bg-surface px-2 text-[13px] text-ink outline-none focus:border-accent/50 disabled:opacity-60', tone)}
      />
      {value && !disabled && (
        <button type="button" onClick={() => onChange(null)} className="btn-icon h-7 w-7" aria-label={`Убрать: ${label}`}>
          <X size={13} />
        </button>
      )}
    </span>
  );
}
