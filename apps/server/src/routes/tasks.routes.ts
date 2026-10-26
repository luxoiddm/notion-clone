import { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { AuthService, requireAuth, roleAtLeast } from '@core/auth';
import type {
  FsEngine,
  Task,
  TaskActivity,
  TaskEventType,
  TaskPageRef,
  TaskProject,
  TaskStatus,
  TaskSubtask,
} from '@core/fs-engine';
import {
  emitTaskActivity,
  emitTaskDeleted,
  emitTaskNotify,
  emitTaskProjectsChanged,
  emitTaskUpdated,
  type RealtimeServer,
  type TaskNotifyPayload,
} from '@core/realtime';
import { asyncRoute } from '../middleware/errorHandler.js';
import { refKey, resolveSharedRefs, syncTaskPageGrants } from '../lib/taskPageAccess.js';
import { canSeeProject, canSeeTask, isGlobalTaskManager, isTaskMember, splitForViewer, stubOf, type Viewer } from '../lib/taskVisibility.js';
import { documentWriteLimiter, readLimiter } from '../middleware/rateLimiter.js';

// ------------------------------------------------------------------ даты (YYYY-MM-DD, без часовых поясов)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function toUtc(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y!, m! - 1, day!);
}

function diffDays(a: string, b: string): number {
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

function addDays(d: string, n: number): string {
  const t = new Date(toUtc(d) + n * 86_400_000);
  return t.toISOString().slice(0, 10);
}

function dateOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(toUtc(v))) return v;
  throw new HttpError(400, 'Дата должна быть в формате ГГГГ-ММ-ДД');
}

// ------------------------------------------------------------------ ошибки и проверки

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const STATUSES: TaskStatus[] = ['new', 'in_progress', 'review', 'done', 'postponed', 'canceled'];
const COLORS = ['indigo', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'violet', 'gray'];

type Me = { id: string; role: Parameters<typeof roleAtLeast>[0]; displayName: string };

function me(req: Request): Me {
  return req.user as unknown as Me;
}

/** Менять проект (название, участники) и любые задачи в нём: администратор, тимлид, создатель проекта. */
function canManage(p: TaskProject, u: Me) {
  return isGlobalTaskManager(u) || p.createdBy === u.id;
}

function isParticipant(t: Task, uid: string) {
  return t.authorId === uid || t.assigneeId === uid || t.coAssigneeIds.includes(uid);
}

function canEdit(p: TaskProject, t: Task, u: Me) {
  return isParticipant(t, u.id) || canManage(p, u);
}

/** Дедлайн и приём работы — постановщик (или тот, кто управляет проектом). */
function isController(p: TaskProject, t: Task, u: Me) {
  return t.authorId === u.id || canManage(p, u);
}

function str(v: unknown, max: number, field: string, required = false): string | undefined {
  if (v === undefined) {
    if (required) throw new HttpError(400, `Поле «${field}» обязательно`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `Поле «${field}» должно быть строкой`);
  const s = v.trim();
  if (required && !s) throw new HttpError(400, `Поле «${field}» обязательно`);
  return s.slice(0, max);
}

function idList(v: unknown, valid: Set<string>): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new HttpError(400, 'Ожидается список id');
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && valid.has(x)))];
}

function keyOf(p: TaskProject, t: Task) {
  return `${p.key}-${t.number}`;
}

function isBlocked(t: Task, all: Task[]): boolean {
  return t.dependsOn.some((id) => {
    const d = all.find((x) => x.id === id);
    return d && d.status !== 'done' && d.status !== 'canceled';
  });
}

/** Есть ли путь from → … → to по «ждёт» (для защиты от циклов). */
function reaches(all: Task[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = all.find((x) => x.id === id);
    if (t) stack.push(...t.dependsOn);
  }
  return false;
}

/** Все задачи, которые прямо или через цепочку ждут `rootId`. */
function dependentsOf(all: Task[], rootId: string): Task[] {
  const out: Task[] = [];
  const queue = [rootId];
  const seen = new Set<string>([rootId]);
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of all) {
      if (t.dependsOn.includes(id) && !seen.has(t.id)) {
        seen.add(t.id);
        out.push(t);
        queue.push(t.id);
      }
    }
  }
  return out;
}

function sanitizeSubtasks(v: unknown, people: Set<string>): TaskSubtask[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new HttpError(400, 'subtasks: ожидается список');
  return v.slice(0, 100).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const s = raw as Record<string, unknown>;
    const title = typeof s.title === 'string' ? s.title.trim().slice(0, 300) : '';
    if (!title) return [];
    return [{
      id: typeof s.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s.id) ? s.id : randomUUID(),
      title,
      done: s.done === true,
      assigneeId: typeof s.assigneeId === 'string' && people.has(s.assigneeId) ? s.assigneeId : null,
      dueDate: dateOrNull(s.dueDate) ?? null,
    }];
  });
}

function sanitizePageRefs(v: unknown): TaskPageRef[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new HttpError(400, 'pageRefs: ожидается список');
  const safe = /^[A-Za-z0-9_-]{1,128}$/;
  return v.slice(0, 30).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.ownerId !== 'string' || typeof r.projectId !== 'string' || typeof r.pageId !== 'string') return [];
    if (!safe.test(r.ownerId) || !safe.test(r.projectId) || !safe.test(r.pageId)) return [];
    return [{ ownerId: r.ownerId, projectId: r.projectId, pageId: r.pageId, title: typeof r.title === 'string' ? r.title.slice(0, 200) : '' }];
  });
}

function sanitizeAttachment(v: unknown): TaskActivity['attachment'] {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  if (typeof a.url !== 'string' || !a.url.startsWith('/api/files/serve/')) return null;
  return {
    url: a.url,
    fileName: typeof a.fileName === 'string' ? a.fileName.slice(0, 200) : 'Файл',
    mimeType: typeof a.mimeType === 'string' ? a.mimeType.split(';')[0]!.slice(0, 100) : 'application/octet-stream',
    size: typeof a.size === 'number' ? a.size : 0,
    ...(a.kind === 'voice' || a.kind === 'round' ? { kind: a.kind } : {}),
    ...(typeof a.duration === 'number' ? { duration: Math.min(3600, Math.max(0, a.duration)) } : {}),
    ...(Array.isArray(a.waveform) ? { waveform: a.waveform.slice(0, 64).map((x) => Math.max(0, Math.min(1, Number(x) || 0))) } : {}),
  };
}

// ------------------------------------------------------------------ маршруты

/**
 * Раздел «Задачи»: проекты, задачи, поручения (принять/отклонить),
 * сдача и приём работы, зависимости со сдвигом цепочки, обсуждение,
 * подписка на календарь. Mounted at /api/tasks.
 *
 * Доступ: проект видят его участники (и Admin). Менять задачу —
 * постановщик, ответственный, соисполнители и те, кто управляет проектом
 * (создатель, Team-Lead-участник, Admin). Дедлайн и приём работы — только
 * постановщик или управляющий проектом.
 */
export function tasksRoutes(auth: AuthService, engine: FsEngine, io: RealtimeServer, webOrigin: string) {
  const router = Router();
  router.use(requireAuth(auth));
  const store = engine.tasks;

  async function people() {
    const users = await engine.listUsers();
    return {
      active: new Set(users.filter((u) => !u.dismissedAt).map((u) => u.id)),
      name: new Map(users.map((u) => [u.id, u.displayName])),
    };
  }

  async function projectFor(req: Request, mode: 'see' | 'manage' = 'see'): Promise<TaskProject> {
    const p = await store.getProject(req.params.projectId!).catch(() => null);
    if (!p || !canSeeProject(p, me(req))) throw new HttpError(404, 'Проект не найден');
    if (mode === 'manage' && !canManage(p, me(req))) throw new HttpError(403, 'Менять проект может его создатель, тимлид или администратор');
    return p;
  }

  function notify(p: TaskProject, t: Task, kind: TaskNotifyPayload['kind'], to: Iterable<string | null | undefined>, by: Me | null, text?: string) {
    const ids = [...to].filter((x): x is string => !!x);
    emitTaskNotify(io, ids, {
      kind,
      projectId: p.id,
      taskId: t.id,
      key: keyOf(p, t),
      title: t.title,
      byId: by?.id ?? null,
      byName: by?.displayName ?? null,
      ...(text ? { text: text.slice(0, 200) } : {}),
    });
  }

  /** Задача, которую пользователь видит; чужая — 404, как будто её нет. */
  async function taskFor(req: Request, p: TaskProject): Promise<Task> {
    const t = await store.getTask(p.id, req.params.taskId!).catch(() => null);
    if (!t || !canSeeTask(p, t, me(req), await visibility())) throw new HttpError(404, 'Задача не найдена');
    return t;
  }

  async function visibility() {
    return (await store.getSettings()).visibility;
  }

  // Кто вообще есть (с ролями) — для рассылки по сокету. Кэш на несколько секунд.
  let viewersCache: { at: number; list: Viewer[] } | null = null;
  async function viewers(): Promise<Viewer[]> {
    if (viewersCache && Date.now() - viewersCache.at < 5000) return viewersCache.list;
    const list = (await engine.listUsers()).filter((x) => !x.dismissedAt && x.enabled !== false).map((x) => ({ id: x.id, role: x.role }));
    viewersCache = { at: Date.now(), list };
    return list;
  }

  /** Кто видит проект (для «проекты изменились»). */
  async function projectAudience(p: TaskProject, extra: string[] = []): Promise<string[]> {
    return [...new Set([...(await viewers()).filter((v) => canSeeProject(p, v)).map((v) => v.id), ...extra])];
  }

  /**
   * Кому слать задачу: `full` — видят её целиком, `stub` — видят только
   * закрытую карточку (их задача с ней связана зависимостью).
   */
  async function audience(p: TaskProject, t: Task): Promise<{ full: string[]; stub: Map<string, Set<string>> }> {
    const vis = await visibility();
    const all = await store.listTasks(p.id);
    const full: string[] = [];
    const stub = new Map<string, Set<string>>();
    for (const v of await viewers()) {
      if (!canSeeProject(p, v)) continue;
      if (canSeeTask(p, t, v, vis)) {
        full.push(v.id);
        continue;
      }
      const mine = all.filter((x) => x.id !== t.id && isTaskMember(x, v.id));
      if (mine.some((x) => x.dependsOn.includes(t.id) || t.dependsOn.includes(x.id))) stub.set(v.id, new Set(mine.map((x) => x.id)));
    }
    return { full, stub };
  }

  /** Разослать изменение задачи; `prev` — кто видел её до изменения (им, если больше не видят, — «удалена»). */
  async function broadcast(p: TaskProject, t: Task, prev?: { full: string[]; stub: Map<string, Set<string>> }, depsChanged = false) {
    try {
      const a = await audience(p, t);
      // Новым участникам и при смене зависимостей нужны ещё закрытые карточки
      // связанных задач — проще попросить их клиенты перечитать обзор целиком.
      const refresh = depsChanged ? new Set([...a.full, ...a.stub.keys()]) : new Set(prev ? a.full.filter((x) => !prev.full.includes(x)) : []);
      emitTaskUpdated(io, a.full.filter((x) => !refresh.has(x)), p.id, t);
      for (const [uid, ids] of a.stub) if (!refresh.has(uid)) emitTaskUpdated(io, [uid], p.id, stubOf(t, ids));
      if (refresh.size) emitTaskProjectsChanged(io, refresh, p.id);
      if (prev) {
        const now = new Set([...a.full, ...a.stub.keys()]);
        const gone = [...prev.full, ...prev.stub.keys()].filter((x) => !now.has(x));
        if (gone.length) emitTaskDeleted(io, gone, p.id, t.id);
      }
    } catch {
      // рассылка — не повод ронять запрос
    }
  }

  async function broadcastActivity(p: TaskProject, t: Task, item: unknown) {
    const a = await audience(p, t).catch(() => null);
    if (a) emitTaskActivity(io, a.full, p.id, t.id, item);
  }

  async function log(p: TaskProject, t: Task, authorId: string, type: TaskEventType, extra: { from?: string | null; to?: string | null; text?: string } = {}) {
    const item: TaskActivity = {
      id: randomUUID(),
      taskId: t.id,
      authorId,
      kind: 'event',
      text: extra.text ?? '',
      event: { type, from: extra.from ?? null, to: extra.to ?? null },
      attachment: null,
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
    await store.appendActivity(p.id, item);
    await broadcastActivity(p, t, item);
  }

  /** Новые участники задачи становятся участниками проекта, иначе они её не увидят. */
  async function ensureMembers(p: TaskProject, ids: (string | null | undefined)[]): Promise<TaskProject> {
    const add = ids.filter((x): x is string => !!x && !p.memberIds.includes(x));
    if (!add.length) return p;
    const updated = await store.mutateProjects((list) => {
      const cur = list.find((x) => x.id === p.id);
      if (!cur) return p;
      cur.memberIds = [...new Set([...cur.memberIds, ...add])];
      cur.updatedAt = new Date().toISOString();
      return { ...cur };
    });
    emitTaskProjectsChanged(io, await projectAudience(updated), p.id);
    return updated;
  }

  /** Задача закрыта — тем, кто её ждал и больше ничего не ждёт, «можно начинать». */
  function notifyUnblocked(p: TaskProject, done: Task, all: Task[], by: Me) {
    for (const t of all) {
      if (!t.dependsOn.includes(done.id) || t.status === 'done' || t.status === 'canceled') continue;
      if (!isBlocked(t, all)) notify(p, t, 'unblocked', [t.assigneeId, ...t.coAssigneeIds], by, `${keyOf(p, done)} готова`);
    }
  }

  const wrap = (fn: (req: Request, res: import('express').Response) => Promise<unknown>) =>
    asyncRoute(async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    });

  // ---------------------------------------------------------------- обзор

  /** Все видимые проекты и их задачи — одним запросом (доска, «Мои задачи», календарь, загрузка). */
  router.get(
    '/overview',
    readLimiter,
    wrap(async (req, res) => {
      const u = me(req);
      const vis = await visibility();
      const projects = (await store.listProjects()).filter((p) => canSeeProject(p, u));
      const parts = await Promise.all(projects.map(async (p) => splitForViewer(p, await store.listTasks(p.id), u, vis)));
      res.json({
        projects,
        tasks: parts.flatMap((x) => x.visible),
        hidden: parts.flatMap((x) => x.hidden),
        today: todayIso(),
        visibility: vis,
      });
    }),
  );

  // ---------------------------------------------------------------- настройки (админка)

  router.get(
    '/settings',
    readLimiter,
    wrap(async (_req, res) => {
      res.json(await store.getSettings());
    }),
  );

  router.patch(
    '/settings',
    documentWriteLimiter,
    wrap(async (req, res) => {
      if (me(req).role !== 'Admin') throw new HttpError(403, 'Настройки задач меняет администратор');
      const v = (req.body as Record<string, unknown>).visibility;
      if (v !== 'own' && v !== 'project') throw new HttpError(400, 'visibility: own или project');
      const updated = await store.updateSettings({ visibility: v });
      // Видимость поменялась у всех — пусть клиенты перечитают обзор.
      const everyone = (await viewers()).map((x) => x.id);
      emitTaskProjectsChanged(io, everyone, '*');
      res.json(updated);
    }),
  );

  // ---------------------------------------------------------------- проекты

  router.post(
    '/projects',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const u = me(req);
      const b = req.body as Record<string, unknown>;
      const name = str(b.name, 80, 'Название', true)!;
      const { active } = await people();
      const memberIds = [...new Set([u.id, ...(idList(b.memberIds, active) ?? [])])];
      const color = typeof b.color === 'string' && COLORS.includes(b.color) ? b.color : 'indigo';
      const wanted = (typeof b.key === 'string' && b.key.trim() ? b.key : name).toUpperCase().replace(/[^A-ZА-ЯЁ0-9]/gu, '').slice(0, 3) || 'ЗАД';
      const now = new Date().toISOString();
      const project = await store.mutateProjects((list) => {
        let key = wanted;
        for (let i = 2; list.some((x) => x.key === key); i++) key = `${wanted}${i}`;
        const p: TaskProject = { id: randomUUID(), key, name, color, memberIds, createdBy: u.id, createdAt: now, updatedAt: now };
        list.push(p);
        return p;
      });
      emitTaskProjectsChanged(io, await projectAudience(project), project.id);
      res.status(201).json(project);
    }),
  );

  router.patch(
    '/projects/:projectId',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const p = await projectFor(req, 'manage');
      const b = req.body as Record<string, unknown>;
      const { active } = await people();
      const name = str(b.name, 80, 'Название');
      const members = idList(b.memberIds, active);
      const before = p.memberIds;
      const updated = await store.mutateProjects((list) => {
        const cur = list.find((x) => x.id === p.id)!;
        if (name) cur.name = name;
        if (typeof b.color === 'string' && COLORS.includes(b.color)) cur.color = b.color;
        if (members) cur.memberIds = [...new Set([cur.createdBy, ...members])];
        cur.updatedAt = new Date().toISOString();
        return { ...cur };
      });
      emitTaskProjectsChanged(io, await projectAudience(updated, before), p.id);
      res.json(updated);
    }),
  );

  router.delete(
    '/projects/:projectId',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const u = me(req);
      const p = await projectFor(req);
      if (!(u.role === 'Admin' || p.createdBy === u.id)) throw new HttpError(403, 'Удалить проект может его создатель или администратор');
      const doomed = await store.listTasks(p.id);
      await store.mutateProjects((list) => {
        const i = list.findIndex((x) => x.id === p.id);
        if (i >= 0) list.splice(i, 1);
      });
      const told = await projectAudience(p);
      await store.deleteProjectData(p.id);
      for (const t of doomed) if (t.pageRefs.some((r) => r.shared)) await syncTaskPageGrants(engine, t, null, u.id);
      emitTaskProjectsChanged(io, told, p.id);
      res.status(204).end();
    }),
  );

  // ---------------------------------------------------------------- задачи

  router.get(
    '/projects/:projectId/tasks/:taskId',
    readLimiter,
    wrap(async (req, res) => {
      const p = await projectFor(req);
      const task = await taskFor(req, p);
      res.json({ task, project: p, activity: await store.listActivity(p.id, task.id) });
    }),
  );

  router.post(
    '/projects/:projectId/tasks',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const u = me(req);
      let p = await projectFor(req);
      const b = req.body as Record<string, unknown>;
      const { active } = await people();
      const title = str(b.title, 300, 'Название', true)!;
      const assigneeId = typeof b.assigneeId === 'string' && active.has(b.assigneeId) ? b.assigneeId : null;
      const co = (idList(b.coAssigneeIds, active) ?? []).filter((x) => x !== assigneeId);
      const watchers = idList(b.watcherIds, active) ?? [];
      const status = typeof b.status === 'string' && STATUSES.includes(b.status as TaskStatus) ? (b.status as TaskStatus) : 'new';
      const source =
        b.source && typeof b.source === 'object' && typeof (b.source as Record<string, unknown>).chatId === 'string'
          ? { chatId: String((b.source as Record<string, unknown>).chatId), messageId: String((b.source as Record<string, unknown>).messageId ?? '') }
          : null;
      p = await ensureMembers(p, [assigneeId, ...co, ...watchers]);
      const pageRefs = await resolveSharedRefs(engine, u, sanitizePageRefs(b.pageRefs) ?? [], []);
      const vis = await visibility();
      const now = new Date().toISOString();
      const task = await store.mutateTasks(p.id, (tasks, next) => {
        // Ждать можно только задачу, которую сам видишь.
        const ids = new Set(tasks.filter((x) => canSeeTask(p, x, u, vis)).map((t) => t.id));
        const t: Task = {
          id: randomUUID(),
          projectId: p.id,
          number: next(),
          title,
          description: str(b.description, 20_000, 'Описание') ?? '',
          status: status === 'done' ? 'new' : status,
          authorId: u.id,
          assigneeId,
          acceptance: assigneeId && assigneeId !== u.id ? 'pending' : 'accepted',
          declineReason: null,
          coAssigneeIds: co,
          watcherIds: watchers,
          startDate: dateOrNull(b.startDate) ?? null,
          dueDate: dateOrNull(b.dueDate) ?? null,
          deadline: dateOrNull(b.deadline) ?? null,
          dependsOn: (Array.isArray(b.dependsOn) ? b.dependsOn : []).filter((x): x is string => typeof x === 'string' && ids.has(x)),
          subtasks: sanitizeSubtasks(b.subtasks, active) ?? [],
          pageRefs,
          source,
          order: Math.max(0, ...tasks.filter((x) => x.status === status).map((x) => x.order)) + 1,
          reminders: [],
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        };
        tasks.push(t);
        return t;
      });
      await log(p, task, u.id, 'created');
      await syncTaskPageGrants(engine, task, task, u.id);
      await broadcast(p, task);
      if (task.assigneeId) notify(p, task, 'assigned', [task.assigneeId], u);
      notify(p, task, 'co-assigned', task.coAssigneeIds, u);
      res.status(201).json(task);
    }),
  );

  router.patch(
    '/projects/:projectId/tasks/:taskId',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const u = me(req);
      let p = await projectFor(req);
      const b = req.body as Record<string, unknown>;
      const current = await taskFor(req, p);
      if (!canEdit(p, current, u)) throw new HttpError(403, 'Менять задачу могут её участники и руководитель проекта');
      const vis = await visibility();
      const prevAudience = await audience(p, current);
      const controller = isController(p, current, u);
      const { active } = await people();

      const title = str(b.title, 300, 'Название');
      if (title === '') throw new HttpError(400, 'Название не может быть пустым');
      const description = str(b.description, 20_000, 'Описание');
      const reason = str(b.reason, 500, 'Причина') ?? '';
      const startDate = dateOrNull(b.startDate);
      const dueDate = dateOrNull(b.dueDate);
      const deadline = dateOrNull(b.deadline);
      const assigneeId = b.assigneeId === undefined ? undefined : typeof b.assigneeId === 'string' && active.has(b.assigneeId) ? b.assigneeId : null;
      const co = idList(b.coAssigneeIds, active);
      const watchers = idList(b.watcherIds, active);
      const subtasks = sanitizeSubtasks(b.subtasks, active);
      // shareRefs: [{ownerId, projectId, pageId}] — открыть уже привязанные документы участникам.
      const shareNow = new Set((sanitizePageRefs(b.shareRefs) ?? []).map(refKey));
      const rawRefs = sanitizePageRefs(b.pageRefs) ?? (shareNow.size ? current.pageRefs : undefined);
      const pageRefs = rawRefs && (await resolveSharedRefs(engine, u, rawRefs, current.pageRefs, shareNow));
      if (shareNow.size && pageRefs && pageRefs.some((r) => shareNow.has(refKey(r)) && !r.shared)) {
        throw new HttpError(403, 'Открыть документ другим может только его владелец или администратор');
      }
      let status = typeof b.status === 'string' && STATUSES.includes(b.status as TaskStatus) ? (b.status as TaskStatus) : undefined;

      if (deadline !== undefined && deadline !== current.deadline && !controller) throw new HttpError(403, 'Дедлайн меняет только постановщик');
      const dueChangedByExecutor = dueDate !== undefined && dueDate !== current.dueDate && !controller;
      if (dueChangedByExecutor && !reason) throw new HttpError(400, 'Укажите причину переноса срока — её увидит постановщик');
      // Исполнитель «закрывает» чужое поручение — это сдача на проверку.
      let submittedInstead = false;
      if (status === 'done' && current.status !== 'done' && !controller && current.authorId !== current.assigneeId) {
        status = 'review';
        submittedInstead = true;
      }
      if (assigneeId !== undefined || co || watchers) p = await ensureMembers(p, [assigneeId, ...(co ?? []), ...(watchers ?? [])]);

      const shifted: { t: Task; from: string | null }[] = [];
      const result = await store.mutateTasks(p.id, (tasks) => {
        const t = tasks.find((x) => x.id === current.id);
        if (!t) throw new HttpError(404, 'Задача не найдена');
        const before = { ...t };
        if (title) t.title = title;
        if (description !== undefined) t.description = description;
        if (startDate !== undefined) t.startDate = startDate;
        if (deadline !== undefined) t.deadline = deadline;
        if (subtasks) t.subtasks = subtasks;
        if (pageRefs) t.pageRefs = pageRefs;
        if (watchers) t.watcherIds = watchers;
        if (typeof b.order === 'number' && Number.isFinite(b.order)) t.order = b.order;
        if (assigneeId !== undefined && assigneeId !== t.assigneeId) {
          t.assigneeId = assigneeId;
          t.acceptance = assigneeId && assigneeId !== t.authorId ? 'pending' : 'accepted';
          t.declineReason = null;
        }
        if (co) t.coAssigneeIds = co.filter((x) => x !== t.assigneeId);
        if (Array.isArray(b.dependsOn)) {
          const deps = [...new Set(b.dependsOn.filter((x): x is string => typeof x === 'string'))];
          for (const d of deps) {
            const target = tasks.find((x) => x.id === d);
            if (d === t.id || !target) throw new HttpError(400, 'Связь с несуществующей задачей');
            if (!t.dependsOn.includes(d) && !canSeeTask(p, target, u, vis)) throw new HttpError(400, 'Связь с несуществующей задачей');
            if (reaches(tasks, d, t.id)) throw new HttpError(400, 'Такая связь замкнёт цепочку саму на себя');
          }
          t.dependsOn = deps;
        }
        if (dueDate !== undefined) {
          const old = t.dueDate;
          t.dueDate = dueDate;
          // Сдвиг цепочки: всё, что ждёт эту задачу, едет на столько же дней.
          if (b.shiftChain === true && old && dueDate) {
            const delta = diffDays(dueDate, old);
            if (delta) {
              for (const dep of dependentsOf(tasks, t.id)) {
                if (dep.status === 'done' || dep.status === 'canceled') continue;
                const from = dep.dueDate;
                if (dep.startDate) dep.startDate = addDays(dep.startDate, delta);
                if (dep.dueDate) dep.dueDate = addDays(dep.dueDate, delta);
                dep.updatedAt = new Date().toISOString();
                shifted.push({ t: { ...dep }, from });
              }
            }
          }
        }
        if (status && status !== t.status) {
          t.status = status;
          t.completedAt = status === 'done' ? new Date().toISOString() : null;
          if (status === 'in_progress' && t.acceptance === 'pending' && u.id === t.assigneeId) t.acceptance = 'accepted';
        }
        t.updatedAt = new Date().toISOString();
        return { task: { ...t }, before, all: tasks.map((x) => ({ ...x })) };
      });
      const { task, before, all } = result;

      // История и уведомления — после записи.
      if (before.assigneeId !== task.assigneeId) {
        await log(p, task, u.id, 'assigned', { from: before.assigneeId, to: task.assigneeId });
        if (task.assigneeId) notify(p, task, 'assigned', [task.assigneeId], u);
      }
      const newCo = task.coAssigneeIds.filter((x) => !before.coAssigneeIds.includes(x));
      if (newCo.length) notify(p, task, 'co-assigned', newCo, u);
      if (co && (newCo.length || before.coAssigneeIds.some((x) => !task.coAssigneeIds.includes(x)))) await log(p, task, u.id, 'people');
      if (before.dueDate !== task.dueDate) {
        await log(p, task, u.id, 'due', { from: before.dueDate, to: task.dueDate, text: reason });
        if (dueChangedByExecutor) notify(p, task, 'due-changed', [task.authorId], u, reason);
      }
      if (before.deadline !== task.deadline) {
        await log(p, task, u.id, 'deadline', { from: before.deadline, to: task.deadline, text: reason });
        notify(p, task, 'due-changed', [task.assigneeId, ...task.coAssigneeIds], u, 'Изменён дедлайн');
      }
      if (before.status !== task.status) {
        if (task.status === 'review') {
          await log(p, task, u.id, 'submitted');
          notify(p, task, 'submitted', [task.authorId], u);
        } else if (task.status === 'done' && task.authorId !== u.id && before.status === 'review') {
          await log(p, task, u.id, 'approved');
          notify(p, task, 'approved', [task.assigneeId, ...task.coAssigneeIds], u);
        } else {
          await log(p, task, u.id, 'status', { from: before.status, to: task.status });
        }
        if (task.status === 'done') notifyUnblocked(p, task, all, u);
      }
      for (const s of shifted) {
        await log(p, s.t, u.id, 'shifted', { from: s.from, to: s.t.dueDate, text: `вслед за ${keyOf(p, task)}` });
        notify(p, s.t, 'due-changed', [s.t.assigneeId, ...s.t.coAssigneeIds], u, `Срок сдвинут вслед за ${keyOf(p, task)}`);
        await broadcast(p, s.t);
      }
      if (
        pageRefs ||
        before.authorId !== task.authorId ||
        before.assigneeId !== task.assigneeId ||
        before.coAssigneeIds.join() !== task.coAssigneeIds.join() ||
        before.watcherIds.join() !== task.watcherIds.join()
      ) {
        await syncTaskPageGrants(engine, task, task, u.id);
      }
      await broadcast(p, task, prevAudience, before.dependsOn.join() !== task.dependsOn.join());
      res.json({ task, shifted: shifted.map((s) => s.t), submittedInstead });
    }),
  );

  /** Поручение и приём работы: accept / decline / submit / approve / return / reopen. */
  router.post(
    '/projects/:projectId/tasks/:taskId/actions',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const u = me(req);
      const p = await projectFor(req);
      const b = req.body as Record<string, unknown>;
      const action = String(b.action ?? '');
      const reason = str(b.reason, 500, 'Причина') ?? '';
      const newDue = dateOrNull(b.dueDate);
      const current = await taskFor(req, p);
      const controller = isController(p, current, u);

      const check = () => {
        switch (action) {
          case 'accept':
          case 'decline':
            if (current.assigneeId !== u.id) throw new HttpError(403, 'Принять или отклонить поручение может только ответственный');
            if (action === 'decline' && !reason) throw new HttpError(400, 'Укажите причину — её увидит постановщик');
            return;
          case 'submit':
            if (current.assigneeId !== u.id && !controller) throw new HttpError(403, 'Сдать работу может ответственный');
            return;
          case 'approve':
          case 'return':
            if (!controller) throw new HttpError(403, 'Принять или вернуть работу может постановщик');
            if (action === 'return' && !reason) throw new HttpError(400, 'Напишите, что поправить');
            return;
          case 'reopen':
            if (!canEdit(p, current, u)) throw new HttpError(403, 'Нет прав на эту задачу');
            return;
          default:
            throw new HttpError(400, 'Неизвестное действие');
        }
      };
      check();

      const { task, all } = await store.mutateTasks(p.id, (tasks) => {
        const t = tasks.find((x) => x.id === current.id)!;
        const now = new Date().toISOString();
        if (action === 'accept') {
          t.acceptance = 'accepted';
          t.declineReason = null;
        } else if (action === 'decline') {
          t.acceptance = 'declined';
          t.declineReason = reason;
        } else if (action === 'submit') {
          // Сам себе поручил — сдавать некому, задача просто готова.
          t.status = t.authorId === u.id ? 'done' : 'review';
          if (t.status === 'done') t.completedAt = now;
        } else if (action === 'approve') {
          t.status = 'done';
          t.completedAt = now;
        } else if (action === 'return') {
          t.status = 'in_progress';
          t.completedAt = null;
          if (newDue) t.dueDate = newDue;
        } else if (action === 'reopen') {
          t.status = 'in_progress';
          t.completedAt = null;
        }
        t.updatedAt = now;
        return { task: { ...t }, all: tasks.map((x) => ({ ...x })) };
      });

      if (action === 'accept') {
        await log(p, task, u.id, 'accepted');
        notify(p, task, 'accepted', [task.authorId], u);
      } else if (action === 'decline') {
        await log(p, task, u.id, 'declined', { text: reason });
        notify(p, task, 'declined', [task.authorId], u, reason);
      } else if (action === 'submit') {
        await log(p, task, u.id, task.status === 'done' ? 'status' : 'submitted', task.status === 'done' ? { from: current.status, to: 'done' } : {});
        if (task.status === 'review') notify(p, task, 'submitted', [task.authorId], u);
      } else if (action === 'approve') {
        await log(p, task, u.id, 'approved');
        notify(p, task, 'approved', [task.assigneeId, ...task.coAssigneeIds], u);
      } else if (action === 'return') {
        await log(p, task, u.id, 'returned', { text: reason, to: newDue ?? null });
        notify(p, task, 'returned', [task.assigneeId], u, reason);
      } else {
        await log(p, task, u.id, 'status', { from: current.status, to: task.status });
      }
      if (task.status === 'done') notifyUnblocked(p, task, all, u);
      await broadcast(p, task);
      res.json(task);
    }),
  );

  router.delete(
    '/projects/:projectId/tasks/:taskId',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const u = me(req);
      const p = await projectFor(req);
      const current = await taskFor(req, p);
      if (!isController(p, current, u)) throw new HttpError(403, 'Удалить задачу может постановщик');
      const told = await audience(p, current);
      const touched = await store.mutateTasks(p.id, (tasks) => {
        const i = tasks.findIndex((x) => x.id === current.id);
        if (i >= 0) tasks.splice(i, 1);
        const changed: Task[] = [];
        for (const t of tasks) {
          if (t.dependsOn.includes(current.id)) {
            t.dependsOn = t.dependsOn.filter((x) => x !== current.id);
            changed.push({ ...t });
          }
        }
        return changed;
      });
      await store.deleteTaskActivity(p.id, current.id);
      await syncTaskPageGrants(engine, current, null, u.id);
      emitTaskDeleted(io, [...told.full, ...told.stub.keys()], p.id, current.id);
      for (const t of touched) await broadcast(p, t);
      res.status(204).end();
    }),
  );

  // ---------------------------------------------------------------- обсуждение

  router.post(
    '/projects/:projectId/tasks/:taskId/comments',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const u = me(req);
      let p = await projectFor(req);
      let task = await taskFor(req, p);
      const b = req.body as Record<string, unknown>;
      const text = str(b.text, 10_000, 'Текст') ?? '';
      const attachment = sanitizeAttachment(b.attachment);
      if (!text && !attachment) throw new HttpError(400, 'Пустой комментарий');
      const { active } = await people();
      const mentions = (idList(b.mentionIds, active) ?? []).filter((x) => x !== u.id);
      // Упомянули того, кто задачу не видит, — он становится наблюдателем,
      // иначе уведомление вело бы в «Задача не найдена».
      const vis = await visibility();
      const roles = new Map((await viewers()).map((v) => [v.id, v]));
      const outsiders = mentions.filter((id) => {
        const v = roles.get(id);
        return v && !canSeeTask(p, task, v, vis);
      });
      if (outsiders.length) {
        const prevAudience = await audience(p, task);
        p = await ensureMembers(p, outsiders);
        task = await store.mutateTasks(p.id, (tasks) => {
          const t = tasks.find((x) => x.id === task.id);
          if (!t) throw new HttpError(404, 'Задача не найдена');
          t.watcherIds = [...new Set([...t.watcherIds, ...outsiders])];
          t.updatedAt = new Date().toISOString();
          return { ...t };
        });
        await log(p, task, u.id, 'people');
        await syncTaskPageGrants(engine, task, task, u.id);
        await broadcast(p, task, prevAudience);
      }
      const item: TaskActivity = {
        id: randomUUID(),
        taskId: task.id,
        authorId: u.id,
        kind: 'comment',
        text,
        event: null,
        attachment,
        createdAt: new Date().toISOString(),
        editedAt: null,
      };
      await store.appendActivity(p.id, item);
      if (attachment) await engine.addTaskFileRef(p.id, attachment.url, task.id).catch(() => undefined);
      await broadcastActivity(p, task, item);
      const preview = text || (attachment?.kind === 'voice' ? 'Голосовое сообщение' : attachment?.kind === 'round' ? 'Кружок' : attachment?.fileName ?? '');
      notify(p, task, 'mention', mentions, u, preview);
      notify(p, task, 'comment', [task.authorId, task.assigneeId, ...task.coAssigneeIds, ...task.watcherIds].filter((x) => x && !mentions.includes(x)), u, preview);
      res.status(201).json(item);
    }),
  );

  router.patch(
    '/projects/:projectId/tasks/:taskId/comments/:commentId',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const u = me(req);
      const p = await projectFor(req);
      const task = await taskFor(req, p);
      const text = str((req.body as Record<string, unknown>).text, 10_000, 'Текст', true)!;
      const item = await store.mutateActivity(p.id, task.id, (items) => {
        const c = items.find((x) => x.id === req.params.commentId && x.kind === 'comment');
        if (!c) throw new HttpError(404, 'Комментарий не найден');
        if (c.authorId !== u.id) throw new HttpError(403, 'Можно править только свои комментарии');
        c.text = text;
        c.editedAt = new Date().toISOString();
        return { ...c };
      });
      await broadcastActivity(p, task, item);
      res.json(item);
    }),
  );

  router.delete(
    '/projects/:projectId/tasks/:taskId/comments/:commentId',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const u = me(req);
      const p = await projectFor(req);
      const task = await taskFor(req, p);
      await store.mutateActivity(p.id, task.id, (items) => {
        const i = items.findIndex((x) => x.id === req.params.commentId && x.kind === 'comment');
        if (i < 0) throw new HttpError(404, 'Комментарий не найден');
        if (items[i]!.authorId !== u.id && !canManage(p, u)) throw new HttpError(403, 'Можно удалить только свой комментарий');
        items.splice(i, 1);
      });
      await broadcastActivity(p, task, { id: req.params.commentId, deleted: true });
      res.status(204).end();
    }),
  );

  // ---------------------------------------------------------------- подписка на календарь

  router.get(
    '/ical',
    readLimiter,
    wrap(async (req, res) => {
      const token = await store.icalToken(me(req).id);
      res.json({ url: `${webOrigin.replace(/\/$/, '')}/api/tasks-ical/${token}.ics` });
    }),
  );

  router.post(
    '/ical/rotate',
    documentWriteLimiter,
    wrap(async (req, res) => {
      const token = await store.icalToken(me(req).id, true);
      res.json({ url: `${webOrigin.replace(/\/$/, '')}/api/tasks-ical/${token}.ics` });
    }),
  );

  return router;
}

// ------------------------------------------------------------------ календарь (iCalendar)

function icsEscape(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Строки длиннее 75 байт переносятся (RFC 5545). */
function icsFold(line: string) {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) {
      out.push(cur);
      cur = ' ' + ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

/**
 * Публичная (без входа) лента iCalendar: календарные программы не умеют
 * авторизоваться, поэтому доступ — по секретной ссылке, как у /f/{token}.
 * Ссылку можно перевыпустить («Сбросить ссылку») — старая перестанет работать.
 * Отдаёт только сроки и дедлайны задач, где пользователь постановщик,
 * ответственный или соисполнитель. Mounted at /api/tasks-ical.
 */
export function tasksIcalRoutes(engine: FsEngine, webOrigin: string) {
  const router = Router();
  router.get(
    '/:file',
    readLimiter,
    asyncRoute(async (req, res) => {
      const token = String(req.params.file ?? '').replace(/\.ics$/, '');
      const userId = await engine.tasks.userByIcalToken(token);
      if (!userId) return res.status(404).type('text').send('Not found');
      const user = await engine.getUser(userId).catch(() => null);
      if (!user || user.dismissedAt || user.enabled === false) return res.status(404).type('text').send('Not found');
      const projects = (await engine.tasks.listProjects()).filter((p) => p.memberIds.includes(userId));
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Workspace//Tasks//RU', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Задачи Workspace', 'X-PUBLISHED-TTL:PT1H'];
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      for (const p of projects) {
        for (const t of await engine.tasks.listTasks(p.id)) {
          if (!isParticipant(t, userId) || t.status === 'canceled') continue;
          const url = `${webOrigin.replace(/\/$/, '')}/tasks?project=${p.id}&task=${t.id}`;
          const done = t.status === 'done' ? '✓ ' : '';
          const add = (kind: 'due' | 'deadline', date: string, label: string) => {
            lines.push(
              'BEGIN:VEVENT',
              `UID:${t.id}-${kind}@workspace`,
              `DTSTAMP:${stamp}`,
              `DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`,
              `DTEND;VALUE=DATE:${addDays(date, 1).replace(/-/g, '')}`,
              icsFold(`SUMMARY:${icsEscape(`${done}${label}: ${p.key}-${t.number} ${t.title}`)}`),
              icsFold(`DESCRIPTION:${icsEscape(`${p.name}\n${url}`)}`),
              icsFold(`URL:${url}`),
              'TRANSP:TRANSPARENT',
              'END:VEVENT',
            );
          };
          if (t.dueDate) add('due', t.dueDate, 'Срок');
          if (t.deadline) add('deadline', t.deadline, 'Дедлайн');
        }
      }
      lines.push('END:VCALENDAR');
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(lines.join('\r\n') + '\r\n');
    }),
  );
  return router;
}

// ------------------------------------------------------------------ напоминания о дедлайнах

/**
 * Раз в полчаса: за 2 дня до дедлайна и в день дедлайна — ответственному
 * и соисполнителям; просрочен — им и постановщику. Каждое напоминание
 * отправляется один раз (отметка в task.reminders).
 */
export function startTaskReminders(engine: FsEngine, io: RealtimeServer): () => void {
  const run = async () => {
    const today = todayIso();
    for (const p of await engine.tasks.listProjects()) {
      const due: { t: Task; kind: TaskNotifyPayload['kind'] }[] = [];
      await engine.tasks.mutateTasks(p.id, (tasks) => {
        for (const t of tasks) {
          if (!t.deadline || t.status === 'done' || t.status === 'canceled') continue;
          const d = diffDays(t.deadline, today);
          const kind: TaskNotifyPayload['kind'] | null = d === 2 ? 'deadline-soon' : d === 0 ? 'deadline-today' : d < 0 ? 'overdue' : null;
          if (!kind) continue;
          const mark = `${kind}:${t.deadline}`;
          if (t.reminders.includes(mark)) continue;
          t.reminders = [...t.reminders, mark].slice(-10);
          due.push({ t: { ...t }, kind });
        }
      });
      for (const { t, kind } of due) {
        const to = [t.assigneeId, ...t.coAssigneeIds, ...(kind === 'overdue' ? [t.authorId] : [])].filter((x): x is string => !!x);
        emitTaskNotify(io, to, { kind, projectId: p.id, taskId: t.id, key: keyOf(p, t), title: t.title, byId: null, byName: null });
      }
    }
  };
  const safe = () => void run().catch((err) => console.warn('[tasks] напоминания:', err));
  const first = setTimeout(safe, 15_000);
  const timer = setInterval(safe, 30 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
