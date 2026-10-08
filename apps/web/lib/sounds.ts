/**
 * Звуки чата и звонков. Синтезируются Web Audio API прямо в браузере —
 * никаких аудиофайлов, лицензий и загрузок; тембр мягкий (синус с плавной
 * атакой и затуханием), чтобы не раздражать в офисе.
 *
 * Настройки — на устройстве (localStorage): у каждого свой ноутбук/телефон,
 * и «тихо на работе, громко дома» — это про устройство, а не про аккаунт.
 *
 * Ограничение браузеров (autoplay policy): звук можно воспроизвести только
 * после первого клика/нажатия клавиши на странице. Поэтому контекст
 * «разблокируется» при первом взаимодействии (unlockAudio в SoundNotifier).
 */

export interface SoundSettings {
  /** Общий выключатель. */
  enabled: boolean;
  /** Новые сообщения в чатах. */
  messages: boolean;
  /** Входящий звонок, гудки, подключение/завершение. */
  calls: boolean;
  /** Короткий звук при отправке своего сообщения. */
  sent: boolean;
  /** Громкость 0…1. */
  volume: number;
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { enabled: true, messages: true, calls: true, sent: false, volume: 0.6 };

const SETTINGS_KEY = 'sound:settings';
const listeners = new Set<(s: SoundSettings) => void>();

export function getSoundSettings(): SoundSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<SoundSettings> | null;
    const s = { ...DEFAULT_SOUND_SETTINGS, ...(raw ?? {}) };
    s.volume = Math.min(1, Math.max(0, Number(s.volume) || 0));
    return s;
  } catch {
    return { ...DEFAULT_SOUND_SETTINGS };
  }
}

export function setSoundSettings(patch: Partial<SoundSettings>): SoundSettings {
  const next = { ...getSoundSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* хранилище недоступно — настройки действуют до перезагрузки */
  }
  for (const l of listeners) l(next);
  return next;
}

export function onSoundSettingsChange(fn: (s: SoundSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- Аудиоконтекст -----------------------------------------------------------

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/** Вызывается на первый клик/клавишу — после этого браузер разрешает звук. */
export function unlockAudio() {
  const c = audio();
  if (c && c.state === 'suspended') void c.resume();
}

export function isAudioUnlocked(): boolean {
  return !!ctx && ctx.state === 'running';
}

interface Note {
  /** Частота, Гц. */
  f: number;
  /** Начало относительно старта звука, с. */
  t: number;
  /** Длительность, с. */
  d: number;
  /** Относительная громкость 0…1. */
  g?: number;
  type?: OscillatorType;
}

/** Проигрывает набор нот; возвращает длительность всего звука, с. */
function play(notes: Note[], volume: number): number {
  const c = audio();
  if (!c || c.state !== 'running' || volume <= 0) return 0;
  const master = c.createGain();
  // Мягкий срез верхов — без «писка» на ноутбучных динамиках.
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 3200;
  master.gain.value = volume * 0.35;
  filter.connect(master).connect(c.destination);
  const now = c.currentTime + 0.01;
  let end = 0;
  for (const n of notes) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = n.type ?? 'sine';
    osc.frequency.value = n.f;
    const start = now + n.t;
    const peak = n.g ?? 1;
    // Плавная атака и экспоненциальное затухание — «колокольчик», без щелчков.
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + n.d);
    osc.connect(g).connect(filter);
    osc.start(start);
    osc.stop(start + n.d + 0.05);
    end = Math.max(end, n.t + n.d);
  }
  setTimeout(() => master.disconnect(), (end + 0.2) * 1000);
  return end;
}

/** Нота с лёгким обертоном (октава выше, тихо) — звучит теплее голого синуса. */
function bell(f: number, t: number, d: number, g = 1): Note[] {
  return [
    { f, t, d, g },
    { f: f * 2, t, d: d * 0.6, g: g * 0.18 },
  ];
}

// ---- Звуки -------------------------------------------------------------------

export type SoundName = 'message' | 'sent' | 'call-connected' | 'call-ended' | 'peer-joined' | 'peer-left' | 'busy';

const SOUNDS: Record<SoundName, () => Note[]> = {
  // Два восходящих мягких тона (E6 → A6).
  message: () => [...bell(1318.5, 0, 0.32, 0.8), ...bell(1760, 0.11, 0.42, 0.7)],
  // Короткий тихий «тик».
  sent: () => [{ f: 900, t: 0, d: 0.09, g: 0.35 }],
  // Восходящее трезвучие — «соединились».
  'call-connected': () => [...bell(659.3, 0, 0.25, 0.8), ...bell(830.6, 0.09, 0.25, 0.8), ...bell(987.8, 0.18, 0.4, 0.8)],
  // Нисходящие два тона — «звонок завершён».
  'call-ended': () => [...bell(783.99, 0, 0.3, 0.8), ...bell(523.25, 0.16, 0.5, 0.8)],
  'peer-joined': () => [...bell(880, 0, 0.18, 0.55), ...bell(1174.7, 0.08, 0.25, 0.55)],
  'peer-left': () => [...bell(1174.7, 0, 0.18, 0.5), ...bell(880, 0.08, 0.25, 0.5)],
  // «Занято»: три коротких гудка 425 Гц.
  busy: () => [0, 0.5, 1].map((t) => ({ f: 425, t, d: 0.35, g: 0.6 })),
};

function allowed(kind: 'messages' | 'calls' | 'sent'): SoundSettings | null {
  const s = getSoundSettings();
  return s.enabled && s[kind] ? s : null;
}

export function playSound(name: SoundName, opts: { force?: boolean } = {}) {
  const kind = name === 'message' ? 'messages' : name === 'sent' ? 'sent' : 'calls';
  const s = opts.force ? getSoundSettings() : allowed(kind);
  if (!s) return;
  play(SOUNDS[name](), s.volume);
}

/**
 * Повторяющийся звук (рингтон входящего, гудки исходящего). Возвращает
 * функцию остановки. Пока контекст не разблокирован, тихо ждёт и начинает
 * звучать с первого же клика по странице.
 */
function loop(pattern: () => Note[], periodMs: number, maxMs: number, opts: { force?: boolean } = {}): () => void {
  let stopped = false;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    if (stopped || Date.now() - started > maxMs) return;
    const s = opts.force ? getSoundSettings() : allowed('calls');
    if (s) play(pattern(), s.volume);
    timer = setTimeout(tick, periodMs);
  };
  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Рингтон входящего звонка: мягкое арпеджио, раз в 2,5 с, не дольше 45 с. */
export function startRingtone(opts: { force?: boolean; maxMs?: number } = {}): () => void {
  const pattern = () => [
    ...bell(659.3, 0, 0.35, 0.9),
    ...bell(830.6, 0.14, 0.35, 0.9),
    ...bell(987.8, 0.28, 0.35, 0.9),
    ...bell(1318.5, 0.42, 0.6, 0.9),
    ...bell(987.8, 0.9, 0.35, 0.7),
    ...bell(1318.5, 1.04, 0.7, 0.8),
  ];
  return loop(pattern, 2600, opts.maxMs ?? 45_000, opts);
}

/** Гудки исходящего (пока никто не ответил): 425 Гц, 1 с звук / 3 с пауза. */
export function startRingback(opts: { force?: boolean; maxMs?: number } = {}): () => void {
  const pattern = () => [{ f: 425, t: 0, d: 1, g: 0.45 }];
  return loop(pattern, 4000, opts.maxMs ?? 60_000, opts);
}

// ---- Кто играет звук, если открыто несколько вкладок -------------------------

/**
 * Одно событие (сообщение, звонок) приходит во все открытые вкладки —
 * звучать должна одна. Первая вкладка «забирает» ключ в localStorage,
 * остальные молчат.
 */
export function claimOnce(key: string, ttlMs = 10_000): boolean {
  try {
    const k = `sound:claim:${key}`;
    const now = Date.now();
    const prev = Number(localStorage.getItem(k) ?? 0);
    if (prev && now - prev < ttlMs) return false;
    localStorage.setItem(k, String(now));
    // Подчищаем старые ключи, чтобы не копились.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const name = localStorage.key(i);
      if (name?.startsWith('sound:claim:') && now - Number(localStorage.getItem(name) ?? 0) > 60_000) localStorage.removeItem(name);
    }
    return true;
  } catch {
    return true;
  }
}

// ---- Какой чат сейчас открыт ------------------------------------------------
// Общий для всех вкладок ключ: какой чат открыт в вкладке, которая сейчас
// на экране и в фокусе. Если новое сообщение пришло именно туда — звук не
// нужен ни в одной вкладке (человек и так его видит).

let openChatId: string | null = null;
const VISIBLE_KEY = 'sound:visible-chat';

function publishVisibleChat() {
  try {
    const visible = typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
    const current = JSON.parse(localStorage.getItem(VISIBLE_KEY) ?? 'null') as { chatId: string; tab: string } | null;
    if (visible && openChatId) localStorage.setItem(VISIBLE_KEY, JSON.stringify({ chatId: openChatId, tab: TAB_ID }));
    else if (current?.tab === TAB_ID) localStorage.removeItem(VISIBLE_KEY);
  } catch {
    /* ignore */
  }
}

const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());

/** ChatWindow сообщает, какой чат открыт (null — закрыт). */
export function setOpenChat(chatId: string | null) {
  openChatId = chatId;
  publishVisibleChat();
}

/** Подписка на фокус/видимость вкладки — вызывается один раз (SoundNotifier). */
export function trackVisibility(): () => void {
  const update = () => publishVisibleChat();
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  window.addEventListener('pagehide', () => {
    openChatId = null;
    publishVisibleChat();
  });
  update();
  return () => {
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    document.removeEventListener('visibilitychange', update);
  };
}

export function isChatOpenAndVisible(chatId: string): boolean {
  if (openChatId === chatId && document.visibilityState === 'visible' && document.hasFocus()) return true;
  try {
    const current = JSON.parse(localStorage.getItem(VISIBLE_KEY) ?? 'null') as { chatId: string } | null;
    return current?.chatId === chatId;
  } catch {
    return false;
  }
}
