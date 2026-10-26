import fs from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { assertSafeId, joinSafe } from './pathSafety.js';
import { lockManager } from './lockManager.js';
import { FsEngineError } from './types.js';
import type { Task, TaskActivity, TaskPageGrant, TaskProject, TaskSettings } from './taskTypes.js';

async function readJsonOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback;
    throw new FsEngineError(`Failed to read JSON: ${filePath}`, 'IO_ERROR', err);
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw new FsEngineError(`Failed to write JSON: ${filePath}`, 'IO_ERROR', err);
  }
}

interface ProjectsFile {
  v: 1;
  projects: TaskProject[];
}

interface TasksFile {
  v: 1;
  seq: number;
  tasks: Task[];
}

/**
 * Хранилище раздела «Задачи» (часть `@core/fs-engine`, как и всё, что
 * трогает диск). Только чтение/запись под блокировками — права доступа,
 * уведомления и правила переходов статусов живут в маршрутах сервера.
 * Схема файлов — в `taskTypes.ts`.
 */
export class TaskStore {
  private readonly dir: string;

  constructor(storageRoot: string) {
    this.dir = joinSafe(storageRoot, 'tasks');
  }

  private projectsPath() {
    return joinSafe(this.dir, 'projects.json');
  }
  private projectDir(projectId: string) {
    return joinSafe(this.dir, assertSafeId(projectId, 'projectId'));
  }
  private tasksPath(projectId: string) {
    return joinSafe(this.projectDir(projectId), 'tasks.json');
  }
  private activityPath(projectId: string, taskId: string) {
    return joinSafe(this.projectDir(projectId), 'activity', `${assertSafeId(taskId, 'taskId')}.jsonl`);
  }
  private settingsPath() {
    return joinSafe(this.dir, 'settings.json');
  }

  private grantsPath() {
    return joinSafe(this.dir, 'page-grants.json');
  }

  private icalPath() {
    return joinSafe(this.dir, 'ical-tokens.json');
  }

  // ------------------------------------------------------------------ проекты

  async listProjects(): Promise<TaskProject[]> {
    return (await readJsonOr<ProjectsFile>(this.projectsPath(), { v: 1, projects: [] })).projects;
  }

  async getProject(projectId: string): Promise<TaskProject> {
    const p = (await this.listProjects()).find((x) => x.id === projectId);
    if (!p) throw new FsEngineError(`Task project not found: ${projectId}`, 'NOT_FOUND');
    return p;
  }

  /** Изменить список проектов атомарно; `fn` возвращает результат вызова. */
  async mutateProjects<T>(fn: (projects: TaskProject[]) => T): Promise<T> {
    const p = this.projectsPath();
    await fs.mkdir(this.dir, { recursive: true });
    return lockManager.run(p, async () => {
      const file = await readJsonOr<ProjectsFile>(p, { v: 1, projects: [] });
      const result = fn(file.projects);
      await writeJsonAtomic(p, file);
      return result;
    });
  }

  async deleteProjectData(projectId: string): Promise<void> {
    await fs.rm(this.projectDir(projectId), { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ задачи

  async listTasks(projectId: string): Promise<Task[]> {
    return (await readJsonOr<TasksFile>(this.tasksPath(projectId), { v: 1, seq: 0, tasks: [] })).tasks;
  }

  async getTask(projectId: string, taskId: string): Promise<Task> {
    const t = (await this.listTasks(projectId)).find((x) => x.id === taskId);
    if (!t) throw new FsEngineError(`Task not found: ${taskId}`, 'NOT_FOUND');
    return t;
  }

  /**
   * Атомарное изменение задач проекта. `fn` получает весь массив (можно
   * менять на месте) и следующий свободный номер (`nextNumber()` — для
   * новых задач).
   */
  async mutateTasks<T>(projectId: string, fn: (tasks: Task[], nextNumber: () => number) => T): Promise<T> {
    const p = this.tasksPath(projectId);
    await fs.mkdir(this.projectDir(projectId), { recursive: true });
    return lockManager.run(p, async () => {
      const file = await readJsonOr<TasksFile>(p, { v: 1, seq: 0, tasks: [] });
      const result = fn(file.tasks, () => ++file.seq);
      await writeJsonAtomic(p, file);
      return result;
    });
  }

  async deleteTaskActivity(projectId: string, taskId: string): Promise<void> {
    await fs.rm(this.activityPath(projectId, taskId), { force: true });
  }

  // ------------------------------------------------------------------ обсуждение и история

  async listActivity(projectId: string, taskId: string): Promise<TaskActivity[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.activityPath(projectId, taskId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw new FsEngineError('Failed to read task activity', 'IO_ERROR', err);
    }
    const out: TaskActivity[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TaskActivity);
      } catch {
        /* битая строка — пропускаем, остальное читаем */
      }
    }
    return out;
  }

  async appendActivity(projectId: string, item: TaskActivity): Promise<TaskActivity> {
    const p = this.activityPath(projectId, item.taskId);
    await fs.mkdir(joinSafe(this.projectDir(projectId), 'activity'), { recursive: true });
    await lockManager.run(p, () => fs.appendFile(p, JSON.stringify(item) + '\n', 'utf-8'));
    return item;
  }

  /** Переписать ленту задачи (правка/удаление комментария). */
  async mutateActivity<T>(projectId: string, taskId: string, fn: (items: TaskActivity[]) => T): Promise<T> {
    const p = this.activityPath(projectId, taskId);
    return lockManager.run(p, async () => {
      const items = await this.listActivity(projectId, taskId);
      const result = fn(items);
      const tmp = `${p}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), 'utf-8');
      await fs.rename(tmp, p);
      return result;
    });
  }

  /** Все ссылки на файлы во вложениях обсуждений (для проверки доступа к файлам). */
  async activityAttachmentUrls(projectId: string, taskId: string): Promise<string[]> {
    return (await this.listActivity(projectId, taskId)).flatMap((a) => (a.attachment?.url ? [a.attachment.url] : []));
  }

  // ------------------------------------------------------------------ подписка на календарь

  /** Секретная ссылка подписки пользователя (создаётся при первом запросе). */
  async icalToken(userId: string, rotate = false): Promise<string> {
    const p = this.icalPath();
    await fs.mkdir(this.dir, { recursive: true });
    return lockManager.run(p, async () => {
      const map = await readJsonOr<Record<string, string>>(p, {});
      let token = Object.entries(map).find(([, uid]) => uid === userId)?.[0];
      if (token && rotate) {
        delete map[token];
        token = undefined;
      }
      if (!token) {
        token = randomBytes(24).toString('base64url');
        map[token] = userId;
        await writeJsonAtomic(p, map);
      }
      return token;
    });
  }

  async userByIcalToken(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const map = await readJsonOr<Record<string, string>>(this.icalPath(), {});
    return Object.prototype.hasOwnProperty.call(map, token) ? map[token]! : null;
  }

  // ------------------------------------------------------------------ доступ к документам через задачи

  async listPageGrants(): Promise<TaskPageGrant[]> {
    return (await readJsonOr<{ v: 1; grants: TaskPageGrant[] }>(this.grantsPath(), { v: 1, grants: [] })).grants;
  }

  /** Читает-меняет-пишет учёт под блокировкой; `fn` может быть асинхронной (внутри меняется доступ к страницам). */
  async mutatePageGrants<T>(fn: (grants: TaskPageGrant[]) => Promise<T> | T): Promise<T> {
    const p = this.grantsPath();
    await fs.mkdir(this.dir, { recursive: true });
    return lockManager.run(p, async () => {
      const file = await readJsonOr<{ v: 1; grants: TaskPageGrant[] }>(p, { v: 1, grants: [] });
      const result = await fn(file.grants);
      await writeJsonAtomic(p, { v: 1, grants: file.grants });
      return result;
    });
  }

  // ------------------------------------------------------------------ настройки раздела

  async getSettings(): Promise<TaskSettings> {
    const raw = await readJsonOr<Partial<TaskSettings>>(this.settingsPath(), {});
    return { visibility: raw.visibility === 'project' ? 'project' : 'own' };
  }

  async updateSettings(patch: Partial<TaskSettings>): Promise<TaskSettings> {
    const p = this.settingsPath();
    await fs.mkdir(this.dir, { recursive: true });
    return lockManager.run(p, async () => {
      const next = { ...(await this.getSettings()), ...patch };
      await writeJsonAtomic(p, next);
      return next;
    });
  }
}
