/**
 * Запись голосовых и видео-кружков в браузере (MediaRecorder).
 *
 * Chrome/Firefox/Android пишут WebM (Opus/VP8), Safari на iPhone и Mac —
 * MP4 (AAC/H.264). Сервер хранит файл как есть. Длительность и форма
 * волны считаются здесь же и уходят вместе с сообщением: WebM из
 * MediaRecorder не содержит длительности, и без неё плеер показывал бы «∞».
 */

export type RecordKind = 'voice' | 'round';

export const MAX_SECONDS: Record<RecordKind, number> = { voice: 10 * 60, round: 60 };
/** Короче — считаем случайным нажатием и не отправляем. */
export const MIN_SECONDS = 0.7;
const WAVEFORM_BARS = 48;

export function canRecord(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    window.isSecureContext
  );
}

function pickMime(kind: RecordKind): string {
  const candidates =
    kind === 'voice'
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus']
      : ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
  for (const c of candidates) if (MediaRecorder.isTypeSupported?.(c)) return c;
  return '';
}

function extensionFor(mime: string): string {
  if (mime.includes('mp4')) return mime.startsWith('audio') ? 'm4a' : 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

export interface RecordingResult {
  file: File;
  kind: RecordKind;
  duration: number;
  waveform?: number[];
}

/** Сжимает поток уровней громкости до фиксированного числа столбиков 0..1. */
function toWaveform(levels: number[]): number[] {
  if (!levels.length) return [];
  const out: number[] = [];
  const step = levels.length / WAVEFORM_BARS;
  for (let i = 0; i < WAVEFORM_BARS; i++) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let peak = 0;
    for (let j = from; j < to && j < levels.length; j++) peak = Math.max(peak, levels[j]!);
    out.push(peak);
  }
  const max = Math.max(...out, 0.01);
  return out.map((v) => Math.round(Math.min(1, v / max) * 100) / 100);
}

function fileName(kind: RecordKind, ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return `${kind === 'voice' ? 'Голосовое' : 'Кружок'} ${stamp}.${ext}`;
}

/**
 * Одна запись: start() → (stop() | cancel()). Уровень громкости 0..1
 * приходит в onLevel ~20 раз в секунду (для «дыхания» кнопки и волны).
 */
export class Recording {
  readonly kind: RecordKind;
  stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mime = '';
  private startedAt = 0;
  private levels: number[] = [];
  private audioCtx: AudioContext | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  onLevel: ((level: number) => void) | null = null;

  constructor(kind: RecordKind) {
    this.kind = kind;
  }

  /** Запрашивает микрофон/камеру и начинает запись. Бросает исключение, если доступа нет. */
  async start(): Promise<void> {
    const constraints: MediaStreamConstraints =
      this.kind === 'voice'
        ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
        : {
            audio: { echoCancellation: true, noiseSuppression: true },
            video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
          };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (this.finished) {
      // Отпустили кнопку, пока браузер спрашивал разрешение.
      this.releaseDevices();
      throw new DOMException('Запись отменена', 'AbortError');
    }
    this.mime = pickMime(this.kind);
    this.recorder = new MediaRecorder(this.stream, {
      ...(this.mime ? { mimeType: this.mime } : {}),
      audioBitsPerSecond: this.kind === 'voice' ? 48_000 : 64_000,
      ...(this.kind === 'round' ? { videoBitsPerSecond: 1_000_000 } : {}),
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.recorder.start(250);
    this.startedAt = performance.now();
    this.watchLevel();
  }

  get elapsed(): number {
    return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  get started(): boolean {
    return !!this.recorder;
  }

  private watchLevel() {
    if (!this.stream) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctx();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      this.levelTimer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / buf.length);
        const level = Math.min(1, rms * 3.2);
        this.levels.push(level);
        this.onLevel?.(level);
      }, 50);
    } catch {
      /* без индикатора громкости тоже работаем */
    }
  }

  private releaseDevices() {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  /** Останавливает запись и возвращает файл; null — если вышло слишком коротко. */
  stop(): Promise<RecordingResult | null> {
    this.finished = true;
    const recorder = this.recorder;
    const duration = this.elapsed;
    if (!recorder || recorder.state === 'inactive') {
      this.releaseDevices();
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        this.releaseDevices();
        if (duration < MIN_SECONDS || !this.chunks.length) return resolve(null);
        const type = (recorder.mimeType || this.mime || (this.kind === 'voice' ? 'audio/webm' : 'video/webm')).split(';')[0]!;
        const blob = new Blob(this.chunks, { type });
        const file = new File([blob], fileName(this.kind, extensionFor(type)), { type });
        resolve({
          file,
          kind: this.kind,
          duration: Math.round(Math.min(duration, MAX_SECONDS[this.kind]) * 10) / 10,
          waveform: this.kind === 'voice' ? toWaveform(this.levels) : undefined,
        });
      };
      recorder.stop();
    });
  }

  cancel() {
    this.finished = true;
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.releaseDevices();
  }
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Только одно голосовое/кружок со звуком играет одновременно. */
let currentMedia: HTMLMediaElement | null = null;
export function claimPlayback(el: HTMLMediaElement) {
  if (currentMedia && currentMedia !== el && !currentMedia.paused) currentMedia.pause();
  currentMedia = el;
}
