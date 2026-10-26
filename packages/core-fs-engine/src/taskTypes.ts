/**
 * Раздел «Задачи». Хранится отдельно от папок пользователей — задачи
 * общие для участников проекта:
 *
 *   STORAGE_ROOT/tasks/projects.json              — список проектов задач
 *   STORAGE_ROOT/tasks/{projectId}/tasks.json     — задачи проекта + счётчик номеров
 *   STORAGE_ROOT/tasks/{projectId}/activity/{taskId}.jsonl — обсуждение и история задачи
 *   STORAGE_ROOT/tasks/ical-tokens.json           — секретные ссылки подписки на календарь
 */

export type TaskStatus = 'new' | 'in_progress' | 'review' | 'done' | 'postponed' | 'canceled';

/** Ответ исполнителя на поручение. Если постановщик сам себе ответственный — сразу 'accepted'. */
export type TaskAcceptance = 'pending' | 'accepted' | 'declined';

export interface TaskProject {
  id: string;
  /** Короткий префикс номеров задач: ПЕР → ПЕР-12. */
  key: string;
  name: string;
  /** Ключ цвета из палитры клиента (indigo, green, amber…). */
  color: string;
  memberIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSubtask {
  id: string;
  title: string;
  done: boolean;
  assigneeId: string | null;
  /** YYYY-MM-DD */
  dueDate: string | null;
}

export interface TaskPageRef {
  ownerId: string;
  projectId: string;
  pageId: string;
  /** Название на момент привязки — чтобы список не был пустым, пока карточка загружается. */
  title: string;
  /**
   * Документ открыт участникам задачи: привязал владелец документа (или
   * тот, кто может управлять его доступом, или администратор). Тогда
   * постановщик, ответственный и соисполнители получают «редактирование»,
   * наблюдатели — «чтение»; см. `TaskPageGrant`. Ставит только сервер.
   */
  shared?: boolean;
}

/**
 * Учёт доступа к документам, выданного задачами (`tasks/page-grants.json`).
 * Нужен, чтобы забрать доступ, когда человек перестал участвовать во всех
 * задачах с этим документом или документ отвязали, — и не тронуть доступ,
 * выданный владельцем вручную: `prevLevel` — что было до задачи (null —
 * доступа не было), откат делается, только если уровень всё ещё наш.
 */
export interface TaskPageGrant {
  ownerId: string;
  projectId: string;
  pageId: string;
  userId: string;
  level: 'read' | 'comment' | 'edit' | 'admin';
  prevLevel: 'read' | 'comment' | 'edit' | 'admin' | null;
  /** Задачи (`{projectId}:{taskId}`), ради которых выдан доступ. */
  taskIds: string[];
}

export interface Task {
  id: string;
  projectId: string;
  /** Порядковый номер в проекте: ключ задачи = `${project.key}-${number}`. */
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  /** Постановщик — поручил задачу и принимает работу. */
  authorId: string;
  /** Ответственный — всегда один (или ещё не назначен). */
  assigneeId: string | null;
  acceptance: TaskAcceptance;
  declineReason: string | null;
  coAssigneeIds: string[];
  watcherIds: string[];
  /** Даты — YYYY-MM-DD (без времени и часового пояса). */
  startDate: string | null;
  /** Срок — плановая дата, её можно двигать (с причиной). */
  dueDate: string | null;
  /** Дедлайн — жёсткая дата, её меняет только постановщик. */
  deadline: string | null;
  /** Задачи этого же проекта, которые должны быть готовы раньше («ждёт»). */
  dependsOn: string[];
  subtasks: TaskSubtask[];
  pageRefs: TaskPageRef[];
  /** Задача создана из сообщения чата. */
  source: { chatId: string; messageId: string } | null;
  /** Порядок внутри колонки доски. */
  order: number;
  /** Какие напоминания о дедлайне уже отправлены (ключ — `${вид}:${дата дедлайна}`). */
  reminders: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type TaskEventType =
  | 'created'
  | 'assigned'
  | 'accepted'
  | 'declined'
  | 'status'
  | 'due'
  | 'deadline'
  | 'submitted'
  | 'approved'
  | 'returned'
  | 'shifted'
  | 'people';

export interface TaskActivity {
  id: string;
  taskId: string;
  authorId: string;
  kind: 'comment' | 'event';
  /** Текст комментария (Markdown) или причина/пояснение к событию. */
  text: string;
  event: { type: TaskEventType; from?: string | null; to?: string | null } | null;
  attachment: { url: string; fileName: string; mimeType: string; size: number; kind?: 'voice' | 'round'; duration?: number; waveform?: number[] } | null;
  createdAt: string;
  editedAt: string | null;
}

/**
 * Настройки раздела «Задачи» (`tasks/settings.json`, меняет администратор).
 * `visibility`:
 * - 'own' — сотрудник видит в проекте только задачи, где он участвует
 *   (постановщик, ответственный, соисполнитель, наблюдатель);
 * - 'project' — участники проекта видят все его задачи.
 * Администраторы, тимлиды и создатель проекта видят всё в любом режиме.
 */
export type TaskVisibility = 'own' | 'project';
export interface TaskSettings {
  visibility: TaskVisibility;
}
