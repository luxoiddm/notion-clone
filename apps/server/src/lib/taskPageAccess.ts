import type { AccessLevel, FsEngine, Task, TaskPageGrant, TaskPageRef } from '@core/fs-engine';
import { hasAccess } from '../routes/storage.routes.js';

/**
 * Доступ к документам, привязанным к задаче.
 *
 * Привязал документ его владелец (или тот, кто вправе управлять его
 * доступом, или администратор) — ссылка помечается `shared`, и все
 * участники задачи получают доступ: постановщик, ответственный,
 * соисполнители — «редактирование», наблюдатели — «чтение». Меняется
 * состав задачи — доступ выдаётся новым и забирается у ушедших.
 * Привязал кто-то другой — ссылка просто ссылка: кто не имел доступа,
 * видит «Нет доступа» (иначе через задачу можно было бы раздать чужой
 * документ кому угодно).
 *
 * Что выдано задачами, записано в `tasks/page-grants.json`
 * (`TaskPageGrant`) — забираем только своё: если владелец уже сам
 * поменял уровень доступа человеку, его решение не трогаем.
 */

const RANK: Record<AccessLevel, number> = { read: 0, comment: 1, edit: 2, admin: 3 };

type Actor = { id: string; role: string };

export const refKey = (r: { ownerId: string; projectId: string; pageId: string }) => `${r.ownerId}/${r.projectId}/${r.pageId}`;
const taskTag = (t: { projectId: string; id: string }) => `${t.projectId}:${t.id}`;

/** Может ли `actor` открыть этот документ другим людям. */
export async function canSharePage(engine: FsEngine, actor: Actor, ref: TaskPageRef): Promise<boolean> {
  const meta = await engine.getPageMeta(ref.ownerId, ref.projectId, ref.pageId).catch(() => null);
  if (!meta) return false;
  if (ref.ownerId === actor.id || actor.role === 'Admin') return true;
  return hasAccess(ref.ownerId, actor.id, meta.sharing, 'admin');
}

/**
 * Проставляет `shared` у ссылок: у уже привязанных — как было (клиент
 * этот флаг не задаёт), у новых — по правам того, кто привязывает.
 * `shareNow` — ключи уже привязанных ссылок, которые просят открыть
 * участникам сейчас (кнопка «Открыть участникам» — для ссылок, привязанных
 * до 1.54.0 или не владельцем); тоже только по правам.
 */
export async function resolveSharedRefs(
  engine: FsEngine,
  actor: Actor,
  incoming: TaskPageRef[],
  before: TaskPageRef[],
  shareNow: Set<string> = new Set(),
): Promise<TaskPageRef[]> {
  const prev = new Map(before.map((r) => [refKey(r), r]));
  const out: TaskPageRef[] = [];
  for (const r of incoming) {
    const old = prev.get(refKey(r));
    const shared = old && !(old.shared !== true && shareNow.has(refKey(r))) ? old.shared === true : await canSharePage(engine, actor, r);
    out.push({ ownerId: r.ownerId, projectId: r.projectId, pageId: r.pageId, title: r.title || old?.title || '', ...(shared ? { shared: true } : {}) });
  }
  return out;
}

/** Кому какой доступ нужен по этой задаче. */
function participantLevels(t: Task): Map<string, AccessLevel> {
  const m = new Map<string, AccessLevel>();
  const put = (id: string | null, lvl: AccessLevel) => {
    if (!id) return;
    const cur = m.get(id);
    if (!cur || RANK[lvl] > RANK[cur]) m.set(id, lvl);
  };
  for (const w of t.watcherIds) put(w, 'read');
  put(t.authorId, 'edit');
  put(t.assigneeId, 'edit');
  for (const c of t.coAssigneeIds) put(c, 'edit');
  return m;
}

/**
 * Приводит доступ к документам в соответствие с задачей. `task = null` —
 * задача удалена: забрать всё, что выдавалось ради неё (`tag`).
 */
export async function syncTaskPageGrants(engine: FsEngine, tag: { projectId: string; id: string }, task: Task | null, actorId: string): Promise<void> {
  const me = taskTag(tag);
  const desired = new Map<string, { ref: TaskPageRef; userId: string; level: AccessLevel }>();
  if (task) {
    const levels = participantLevels(task);
    for (const ref of task.pageRefs) {
      if (!ref.shared) continue;
      for (const [userId, level] of levels) {
        if (userId === ref.ownerId) continue;
        desired.set(`${refKey(ref)}#${userId}`, { ref, userId, level });
      }
    }
  }

  await engine.tasks.mutatePageGrants(async (grants: TaskPageGrant[]) => {
    const find = (k: string) => grants.find((g) => `${refKey(g)}#${g.userId}` === k);

    for (const [k, d] of desired) {
      const g = find(k);
      if (g) {
        if (!g.taskIds.includes(me)) g.taskIds.push(me);
        if (RANK[d.level] > RANK[g.level]) {
          const from = g.level;
          await engine
            .mutatePageSharing(d.ref.ownerId, d.ref.projectId, d.ref.pageId, (sharing) => {
              const cur = sharing.find((s) => s.userId === d.userId);
              // Владелец сам убрал доступ или поменял уровень — не спорим.
              if (!cur || cur.level !== from) return null;
              cur.level = d.level;
              return sharing;
            }, actorId)
            .then(() => (g.level = d.level))
            .catch(() => undefined);
        }
        continue;
      }
      const box: { created: TaskPageGrant | null } = { created: null };
      await engine
        .mutatePageSharing(d.ref.ownerId, d.ref.projectId, d.ref.pageId, (sharing) => {
          const cur = sharing.find((s) => s.userId === d.userId);
          if (cur && RANK[cur.level] >= RANK[d.level]) return null; // доступ уже есть — ничего не выдаём и не запоминаем
          box.created = { ownerId: d.ref.ownerId, projectId: d.ref.projectId, pageId: d.ref.pageId, userId: d.userId, level: d.level, prevLevel: cur?.level ?? null, taskIds: [me] };
          if (cur) cur.level = d.level;
          else sharing.push({ userId: d.userId, level: d.level });
          return sharing;
        }, actorId)
        .catch(() => undefined);
      if (box.created) grants.push(box.created);
    }

    // Забрать то, что этой задаче больше не нужно.
    for (let i = grants.length - 1; i >= 0; i--) {
      const g = grants[i]!;
      if (!g.taskIds.includes(me) || desired.has(`${refKey(g)}#${g.userId}`)) continue;
      g.taskIds = g.taskIds.filter((x) => x !== me);
      if (g.taskIds.length) continue;
      await engine
        .mutatePageSharing(g.ownerId, g.projectId, g.pageId, (sharing) => {
          const cur = sharing.find((s) => s.userId === g.userId);
          if (!cur || cur.level !== g.level) return null;
          if (g.prevLevel) cur.level = g.prevLevel;
          else sharing.splice(sharing.indexOf(cur), 1);
          return sharing;
        }, actorId)
        .catch(() => undefined); // документ удалён — откатывать нечего
      grants.splice(i, 1);
    }
  });
}
