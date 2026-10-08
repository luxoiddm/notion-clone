/**
 * Счётчик непрочитанных сообщений по чатам — для значка на вкладке «Чаты»
 * и в списке переписок. Серверного «прочитано» в проекте нет, поэтому
 * считаем на устройстве: +1 на каждое 'chat:notify' (сообщение от
 * другого человека в чат, который сейчас не открыт на экране), сброс —
 * когда чат открыт. Хранится в localStorage, общее для всех вкладок.
 */

const KEY = 'chat:unread';
type Counts = Record<string, number>;
const listeners = new Set<(c: Counts) => void>();

function read(): Counts {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Counts) : {};
  } catch {
    return {};
  }
}

function write(c: Counts) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
  for (const l of listeners) l(c);
}

export function getUnread(): Counts {
  return typeof window === 'undefined' ? {} : read();
}

export function totalUnread(c: Counts = getUnread()): number {
  return Object.values(c).reduce((s, n) => s + (n > 0 ? n : 0), 0);
}

export function addUnread(chatId: string) {
  const c = read();
  c[chatId] = (c[chatId] ?? 0) + 1;
  write(c);
}

export function clearUnread(chatId: string) {
  const c = read();
  if (!c[chatId]) return;
  delete c[chatId];
  write(c);
}

/** Подписка на изменения (в т.ч. из других вкладок). */
export function onUnreadChange(fn: (c: Counts) => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) fn(read());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}
