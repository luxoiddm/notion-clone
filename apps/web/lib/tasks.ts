'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, tasksApi, type Task, type TaskActivity, type TaskProject, type TaskStatus, type TaskVisibility } from './api';
import { getSocket } from './socket';

// ------------------------------------------------------------------ справочники

export const STATUS_META: Record<TaskStatus, { label: string; chip: string; dot: string }> = {
  new: { label: 'Новая', chip: 'bg-surface-hover text-ink-muted', dot: 'bg-ink-faint' },
  in_progress: { label: 'В работе', chip: 'bg-accent-soft text-accent-ink', dot: 'bg-accent' },
  review: { label: 'На проверке', chip: 'bg-[#FEF3C7] text-[#92400E] dark:bg-[#4A3612] dark:text-[#FCD58A]', dot: 'bg-[#D97706]' },
  done: { label: 'Готово', chip: 'bg-[#DCFCE7] text-[#166534] dark:bg-[#14301F] dark:text-[#86EFAC]', dot: 'bg-[#16A34A]' },
  postponed: { label: 'Отложена', chip: 'bg-surface-hover text-ink-muted', dot: 'bg-ink-faint' },
  canceled: { label: 'Отменена', chip: 'bg-surface-hover text-ink-faint line-through', dot: 'bg-ink-faint' },
};

/** Колонки доски (отложенные и отменённые — в списке и отдельным фильтром). */
export const BOARD_COLUMNS: TaskStatus[] = ['new', 'in_progress', 'review', 'done'];

export const PROJECT_COLORS: Record<string, string> = {
  indigo: '#5E6AD2',
  blue: '#2563EB',
  teal: '#0D9488',
  green: '#16A34A',
  amber: '#D97706',
  orange: '#EA580C',
  red: '#DC2626',
  pink: '#DB2777',
  violet: '#7C3AED',
  gray: '#71717A',
};

export function projectColor(p: TaskProject | undefined | null): string {
  return PROJECT_COLORS[p?.color ?? 'indigo'] ?? PROJECT_COLORS.indigo!;
}

export function taskKey(p: TaskProject | undefined, t: Task): string {
  return `${p?.key ?? '?'}-${t.number}`;
}

// ------------------------------------------------------------------ даты (YYYY-MM-DD)

export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function toUtc(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y!, m! - 1, day!);
}

export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

export function addDays(d: string, n: number): string {
  return new Date(toUtc(d) + n * 86_400_000).toISOString().slice(0, 10);
}

export function weekday(d: string): number {
  return (new Date(toUtc(d)).getUTCDay() + 6) % 7; // 0 — понедельник
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_LONG = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function fmtDate(d: string | null | undefined, long = false): string {
  if (!d) return '';
  const [, m, day] = d.split('-').map(Number);
  return `${day} ${(long ? MONTHS_LONG : MONTHS_SHORT)[m! - 1]}`;
}

/** «через 3 дня», «завтра», «сегодня», «вчера», «просрочено на 2 дня». */
export function relDay(d: string, today: string): string {
  const n = diffDays(d, today);
  if (n === 0) return 'сегодня';
  if (n === 1) return 'завтра';
  if (n === -1) return 'вчера';
  if (n > 1 && n <= 7) return `через ${n} ${plural(n, 'день', 'дня', 'дней')}`;
  if (n < -1) return `просрочено на ${-n} ${plural(-n, 'день', 'дня', 'дней')}`;
  return '';
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function isOpen(t: Task): boolean {
  return t.status !== 'done' && t.status !== 'canceled';
}

/** Тон чипа срока: просрочено / скоро (≤3 дней) / обычный. */
export function dueTone(t: Task, today: string): 'late' | 'soon' | 'normal' | 'done' {
  if (!isOpen(t)) return 'done';
  if (!t.dueDate) return 'normal';
  const n = diffDays(t.dueDate, today);
  if (n < 0) return 'late';
  if (n <= 3) return 'soon';
  return 'normal';
}

export const TONE_CHIP: Record<ReturnType<typeof dueTone>, string> = {
  late: 'bg-danger/10 text-danger',
  soon: 'bg-[#FEF3C7] text-[#92400E] dark:bg-[#4A3612] dark:text-[#FCD58A]',
  normal: 'bg-surface-hover text-ink-muted',
  done: 'bg-surface-hover text-ink-faint',
};

export function blockersOf(t: Task, byId: Map<string, Task>): Task[] {
  return t.dependsOn.map((id) => byId.get(id)).filter((x): x is Task => !!x && isOpen(x));
}

// ------------------------------------------------------------------ перекрёстная проверка дат

/**
 * Нелогичные даты — только предупреждения, сохранить их можно всегда:
 * начать зависимую работу заранее (пока предыдущая ещё обсуждается)
 * нормально, но это должно быть видно.
 *
 * - `overlap` (жёлтое) — задача начинается не позже срока той, которую
 *   она ждёт: работы идут параллельно.
 * - `order` (красное) — задача должна закончиться раньше той (или в тот же
 *   день), которую ждёт: так не бывает.
 * - `range` (красное) — начало позже срока самой задачи.
 * - `deadline` (красное) — срок позже дедлайна.
 *
 * Закрытые задачи не проверяются: у готовой предшественницы даты уже
 * фактические, отменённая ничего не держит.
 */
export type DateIssueKind = 'overlap' | 'order' | 'range' | 'deadline';
export interface DateIssue {
  kind: DateIssueKind;
  level: 'warn' | 'error';
  /** Задача, с которой конфликт (для overlap/order). */
  other?: Task;
  /** Сколько дней пересекаются / насколько срок позже дедлайна. */
  days: number;
}

export function dateIssues(t: Task, byId: Map<string, Task>): DateIssue[] {
  if (!isOpen(t)) return [];
  const out: DateIssue[] = [];
  if (t.startDate && t.dueDate && t.startDate > t.dueDate) out.push({ kind: 'range', level: 'error', days: diffDays(t.startDate, t.dueDate) });
  if (t.dueDate && t.deadline && t.dueDate > t.deadline) out.push({ kind: 'deadline', level: 'error', days: diffDays(t.dueDate, t.deadline) });
  for (const id of t.dependsOn) {
    const b = byId.get(id);
    if (!b || !isOpen(b) || !b.dueDate) continue;
    if (t.dueDate && t.dueDate <= b.dueDate) out.push({ kind: 'order', level: 'error', other: b, days: diffDays(b.dueDate, t.dueDate) });
    // Срок — включительно (работа идёт и в этот день), поэтому старт в тот же день — уже пересечение на 1 день.
    else if (t.startDate && t.startDate <= b.dueDate) out.push({ kind: 'overlap', level: 'warn', other: b, days: diffDays(b.dueDate, t.startDate) + 1 });
  }
  return out;
}

/** Конфликты задач, которые ждут `t` (для «Блокирует» и стрелок таймлайна). */
export function dependentIssues(t: Task, tasks: Task[], byId: Map<string, Task>): { task: Task; issue: DateIssue }[] {
  const out: { task: Task; issue: DateIssue }[] = [];
  for (const d of tasks) {
    if (!d.dependsOn.includes(t.id)) continue;
    for (const issue of dateIssues(d, byId)) if (issue.other?.id === t.id) out.push({ task: d, issue });
  }
  return out;
}

/** Человеческое описание; `key` — как показывать связанную задачу (ПЕР-4). */
export function describeDateIssue(i: DateIssue, key: (t: Task) => string): string {
  const o = i.other;
  switch (i.kind) {
    case 'range':
      return 'Начало позже срока';
    case 'deadline':
      return `Срок на ${i.days} ${plural(i.days, 'день', 'дня', 'дней')} позже дедлайна`;
    case 'order':
      return `Срок не позже окончания ${o ? key(o) : 'предыдущей'} (${fmtDate(o?.dueDate)}), хотя задача её ждёт`;
    case 'overlap':
      return `Начинается до окончания ${o ? key(o) : 'предыдущей'} (${fmtDate(o?.dueDate)}) — пересечение ${i.days} ${plural(i.days, 'день', 'дня', 'дней')}`;
  }
}

export const ISSUE_TONE = {
  warn: 'bg-[#FEF3C7] text-[#92400E] dark:bg-[#4A3612] dark:text-[#FCD58A]',
  error: 'bg-danger/10 text-danger',
} as const;
export const ISSUE_FIELD_TONE = {
  warn: '!border-[#F59E0B] text-[#92400E] dark:text-[#FCD58A]',
  error: '!border-danger/70 text-danger',
} as const;

/** Самый тяжёлый уровень из списка. */
export function worstLevel(issues: { level: 'warn' | 'error' }[]): 'warn' | 'error' | null {
  if (!issues.length) return null;
  return issues.some((i) => i.level === 'error') ? 'error' : 'warn';
}

// ------------------------------------------------------------------ общее состояние раздела

export interface Person {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  dismissed?: boolean;
}

interface TasksState {
  loaded: boolean;
  error: string | null;
  projects: TaskProject[];
  tasks: Task[];
  /** Закрытые карточки чужих задач, связанных с вашими зависимостью (`hidden: true`). Только для блокировок и проверки дат — в списках не показываются. */
  hidden: Task[];
  /** Настройка админки: 'own' — сотрудники видят только свои задачи. */
  visibility: TaskVisibility;
  today: string;
  people: Map<string, Person>;
}

let state: TasksState = { loaded: false, error: null, projects: [], tasks: [], hidden: [], visibility: 'own', today: todayIso(), people: new Map() };
const listeners = new Set<() => void>();
const activityListeners = new Set<(p: { projectId: string; taskId: string; item: TaskActivity | { id: string; deleted: true } }) => void>();
let loading: Promise<void> | null = null;
let socketBoundTo: string | null = null;

function set(patch: Partial<TasksState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** Текущее состояние вне React (для проверок после refreshTasks). */
export function getTasksState(): TasksState {
  return state;
}

export function refreshTasks(): Promise<void> {
  if (!loading) {
    loading = Promise.all([tasksApi.overview(), state.people.size ? Promise.resolve(null) : api.listUsersDirectory()])
      .then(([o, users]) => {
        set({
          loaded: true,
          error: null,
          projects: o.projects,
          tasks: o.tasks,
          hidden: o.hidden ?? [],
          visibility: o.visibility ?? 'own',
          today: o.today || todayIso(),
          ...(users ? { people: new Map(users.map((u) => [u.id, u])) } : {}),
        });
      })
      .catch((err) => set({ loaded: true, error: err instanceof Error ? err.message : 'Не удалось загрузить задачи' }))
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** Применить ответ сервера локально, не дожидаясь события по сокету. */
export function upsertTask(t: Task) {
  const put = (list: Task[]) => {
    const i = list.findIndex((x) => x.id === t.id);
    const next = [...list];
    if (i >= 0) next[i] = t;
    else next.push(t);
    return next;
  };
  if (t.hidden) set({ hidden: put(state.hidden), tasks: state.tasks.filter((x) => x.id !== t.id) });
  else set({ tasks: put(state.tasks), hidden: state.hidden.filter((x) => x.id !== t.id) });
}

export function removeTask(taskId: string) {
  set({ tasks: state.tasks.filter((t) => t.id !== taskId), hidden: state.hidden.filter((t) => t.id !== taskId) });
}

/** Индекс всех известных задач — свои и закрытые карточки (для блокировок, зависимостей, проверки дат). */
export function taskIndex(tasks: Task[], hidden: Task[] = state.hidden): Map<string, Task> {
  return new Map([...hidden, ...tasks].map((t) => [t.id, t]));
}

/** Название для показа: у закрытой карточки его нет. */
export function taskTitle(t: Task): string {
  return t.hidden ? 'закрытая задача' : t.title;
}

export function upsertProject(p: TaskProject) {
  const i = state.projects.findIndex((x) => x.id === p.id);
  const projects = [...state.projects];
  if (i >= 0) projects[i] = p;
  else projects.push(p);
  set({ projects });
}

function bindSocket(token: string) {
  if (socketBoundTo === token) return;
  socketBoundTo = token;
  const s = getSocket(token);
  s.off('task:updated').on('task:updated', (p: { task: Task }) => upsertTask(p.task));
  s.off('task:deleted').on('task:deleted', (p: { taskId: string }) => removeTask(p.taskId));
  s.off('tasks:projects-changed').on('tasks:projects-changed', () => void refreshTasks());
  s.off('task:activity').on('task:activity', (p: { projectId: string; taskId: string; item: TaskActivity }) => activityListeners.forEach((l) => l(p)));
}

/** Данные раздела «Задачи», общие для всех экранов и счётчика на вкладке. */
export function useTasks(accessToken: string | null): TasksState {
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!accessToken) return;
    bindSocket(accessToken);
    if (!state.loaded && !loading) void refreshTasks();
  }, [accessToken]);
  return snap;
}

export function onTaskActivity(fn: (p: { projectId: string; taskId: string; item: TaskActivity | { id: string; deleted: true } }) => void) {
  activityListeners.add(fn);
  return () => {
    activityListeners.delete(fn);
  };
}

/** Что требует моего действия: принять поручение, проверить работу, просроченное. */
export function actionItems(tasks: Task[], meId: string, today: string) {
  const toAccept = tasks.filter((t) => t.assigneeId === meId && t.acceptance === 'pending' && isOpen(t));
  const toReview = tasks.filter((t) => t.authorId === meId && t.status === 'review' && t.assigneeId !== meId);
  const overdue = tasks.filter(
    (t) => isOpen(t) && t.status !== 'review' && (t.assigneeId === meId || t.coAssigneeIds.includes(meId)) && t.dueDate && diffDays(t.dueDate, today) < 0,
  );
  return { toAccept, toReview, overdue, count: toAccept.length + toReview.length + overdue.length };
}

/** Счётчик для вкладки «Задачи». */
export function useTaskBadge(accessToken: string | null, meId: string | null): number {
  const s = useTasks(accessToken);
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(meId && s.loaded ? actionItems(s.tasks, meId, s.today).count : 0);
  }, [s, meId]);
  return n;
}
