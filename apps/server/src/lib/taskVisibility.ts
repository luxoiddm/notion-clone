import { roleAtLeast, type Role } from '@core/auth';
import type { Task, TaskProject, TaskVisibility } from '@core/fs-engine';

/**
 * Кто что видит в разделе «Задачи» — единственное место с этими правилами
 * (маршруты задач, отдача файлов из обсуждений, рассылка по сокету).
 *
 * - Администраторы и тимлиды — все проекты и все задачи.
 * - Создатель проекта — все задачи своего проекта.
 * - Остальные — проект, если они его участники (туда автоматически
 *   попадает каждый, кого назначили на задачу); внутри — только задачи,
 *   где они постановщик, ответственный, соисполнитель или наблюдатель.
 *   В режиме 'project' (настройка в админке) — все задачи проекта.
 * - Чужая задача, связанная зависимостью с видимой, приходит «закрытой
 *   карточкой» (`stubOf`): номер, статус, даты — без названия и людей.
 */

export type Viewer = { id: string; role: Role };

export function isGlobalTaskManager(u: Viewer): boolean {
  return roleAtLeast(u.role, 'Team-Lead');
}

export function isTaskMember(t: Task, uid: string): boolean {
  return t.authorId === uid || t.assigneeId === uid || t.coAssigneeIds.includes(uid) || t.watcherIds.includes(uid);
}

export function canSeeProject(p: TaskProject, u: Viewer): boolean {
  return isGlobalTaskManager(u) || p.createdBy === u.id || p.memberIds.includes(u.id);
}

/** Видит все задачи проекта (а не только свои). */
export function seesAllTasks(p: TaskProject, u: Viewer, vis: TaskVisibility): boolean {
  return isGlobalTaskManager(u) || p.createdBy === u.id || (vis === 'project' && p.memberIds.includes(u.id));
}

export function canSeeTask(p: TaskProject, t: Task, u: Viewer, vis: TaskVisibility): boolean {
  return canSeeProject(p, u) && (seesAllTasks(p, u, vis) || isTaskMember(t, u.id));
}

export type HiddenTask = Task & { hidden: true };

/** Закрытая карточка: только то, что нужно, чтобы понять блокировку и сроки. */
export function stubOf(t: Task, visibleIds: Set<string>): HiddenTask {
  return {
    ...t,
    title: '',
    description: '',
    authorId: '',
    assigneeId: null,
    acceptance: 'accepted',
    declineReason: null,
    coAssigneeIds: [],
    watcherIds: [],
    deadline: null,
    dependsOn: t.dependsOn.filter((id) => visibleIds.has(id)),
    subtasks: [],
    pageRefs: [],
    source: null,
    reminders: [],
    hidden: true,
  };
}

/** Видимые задачи проекта и закрытые карточки тех, с кем они связаны. */
export function splitForViewer(p: TaskProject, tasks: Task[], u: Viewer, vis: TaskVisibility): { visible: Task[]; hidden: HiddenTask[] } {
  if (seesAllTasks(p, u, vis)) return { visible: tasks, hidden: [] };
  const visible = tasks.filter((t) => isTaskMember(t, u.id));
  const ids = new Set(visible.map((t) => t.id));
  const related = new Set<string>();
  for (const t of visible) for (const d of t.dependsOn) related.add(d);
  for (const t of tasks) if (!ids.has(t.id) && t.dependsOn.some((d) => ids.has(d))) related.add(t.id);
  const hidden = tasks.filter((t) => !ids.has(t.id) && related.has(t.id)).map((t) => stubOf(t, ids));
  return { visible, hidden };
}
