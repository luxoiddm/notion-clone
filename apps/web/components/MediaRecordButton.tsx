'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, Lock, ChevronUp, ChevronLeft, Send, Loader2, Trash2 } from 'lucide-react';
import { Recording, MAX_SECONDS, formatDuration, type RecordKind, type RecordingResult } from '../lib/mediaRecorder';
import { useToast } from './Toast';

/** Значок «кружка»: камера в круге. */
export function RoundIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

const HOLD_MS = 220;
const SWIPE_PX = 28;
const CANCEL_PX = 120;
const LOCK_PX = 90;
const MODE_KEY = 'chat.recordMode';

type Phase = 'idle' | 'starting' | 'recording' | 'locked' | 'sending';

interface Rects {
  bar: DOMRect;
  btn: DOMRect;
}

function readMode(): RecordKind {
  try {
    return localStorage.getItem(MODE_KEY) === 'round' ? 'round' : 'voice';
  } catch {
    return 'voice';
  }
}

/**
 * Кнопка записи вместо «Отправить», пока поле ввода пустое (как в Telegram):
 *  - свайп по кнопке (или короткое нажатие) — переключить микрофон ⇄ камеру;
 *  - удерживать — идёт запись, отпустить — отправить;
 *  - увести палец влево — отмена, вверх до замка — запись без рук.
 * Во время записи поверх поля ввода рисуется панель с таймером, а для
 * кружка — превью с фронтальной камеры в круге по центру экрана.
 */
export function MediaRecordButton({
  anchorRef,
  onRecorded,
}: {
  /** Поле ввода — панель записи ложится точно на него. */
  anchorRef: React.RefObject<HTMLElement>;
  onRecorded: (result: RecordingResult) => Promise<void>;
}) {
  const { push } = useToast();
  const [mode, setMode] = useState<RecordKind>('voice');
  const [phase, setPhaseState] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const [hint, setHint] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [slideX, setSlideX] = useState(0);
  const [lift, setLift] = useState(0);
  const [rects, setRects] = useState<Rects | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const btnRef = useRef<HTMLButtonElement>(null);
  const recRef = useRef<Recording | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swiped = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => setMode(readMode()), []);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 2400);
  }, []);

  const toggleMode = () => {
    const next: RecordKind = mode === 'voice' ? 'round' : 'voice';
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* не страшно */
    }
    navigator.vibrate?.(6);
    showHint(next === 'voice' ? 'Удерживайте — голосовое' : 'Удерживайте — кружок');
  };

  const resetVisuals = () => {
    setSlideX(0);
    setLift(0);
    setLevel(0);
    setElapsed(0);
    setStream(null);
    setRects(null);
  };

  const cancelRecording = useCallback(() => {
    recRef.current?.cancel();
    recRef.current = null;
    startRef.current = null;
    setPhase('idle');
    resetVisuals();
    navigator.vibrate?.([8, 40, 8]);
  }, []);

  const finish = useCallback(async () => {
    const rec = recRef.current;
    recRef.current = null;
    startRef.current = null;
    if (!rec) return;
    if (!rec.started) {
      rec.cancel();
      setPhase('idle');
      resetVisuals();
      return;
    }
    setPhase('sending');
    const result = await rec.stop();
    resetVisuals();
    if (!result) {
      setPhase('idle');
      showHint('Слишком коротко — удерживайте кнопку');
      return;
    }
    try {
      await onRecorded(result);
    } finally {
      setPhase('idle');
    }
  }, [onRecorded, showHint]);

  const beginRecording = async () => {
    holdTimer.current = null;
    const bar = anchorRef.current?.getBoundingClientRect();
    const btn = btnRef.current?.getBoundingClientRect();
    if (!bar || !btn) return;
    setRects({ bar, btn });
    setPhase('starting');
    const rec = new Recording(mode);
    recRef.current = rec;
    rec.onLevel = setLevel;
    try {
      await rec.start();
      if (recRef.current !== rec) {
        rec.cancel();
        return;
      }
      setStream(rec.stream);
      // Пока браузер спрашивал разрешение, могли успеть закрепить запись.
      if (phaseRef.current === 'starting') setPhase('recording');
      navigator.vibrate?.(12);
    } catch (err) {
      if (recRef.current === rec) recRef.current = null;
      setPhase('idle');
      resetVisuals();
      const name = err instanceof DOMException ? err.name : '';
      const what = mode === 'voice' ? 'микрофону' : 'камере';
      if (name === 'AbortError') showHint('Готово — теперь удерживайте кнопку');
      else if (name === 'NotAllowedError' || name === 'SecurityError') push(`Нет доступа к ${what}. Разрешите его в настройках браузера.`, 'error');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') push(mode === 'voice' ? 'Микрофон не найден' : 'Камера не найдена', 'error');
      else push('Не удалось начать запись', 'error');
    }
  };

  // Таймер и автоостановка на лимите.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'locked') return;
    const t = setInterval(() => {
      const rec = recRef.current;
      if (!rec) return;
      setElapsed(rec.elapsed);
      if (rec.elapsed >= MAX_SECONDS[rec.kind]) void finish();
    }, 100);
    return () => clearInterval(t);
  }, [phase, finish]);

  // Превью камеры.
  useEffect(() => {
    if (videoRef.current && stream && mode === 'round') {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [stream, mode, phase]);

  // Esc — отмена закреплённой записи.
  useEffect(() => {
    if (phase !== 'locked') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelRecording();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, cancelRecording]);

  // Ушли из чата посреди записи — микрофон/камеру отпускаем.
  useEffect(() => () => recRef.current?.cancel(), []);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (phaseRef.current !== 'idle' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, y: e.clientY };
    swiped.current = false;
    holdTimer.current = setTimeout(() => void beginRecording(), HOLD_MS);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = startRef.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (holdTimer.current) {
      // Ещё не записываем: быстрый свайп по кнопке — смена режима.
      if (!swiped.current && (dy < -SWIPE_PX || Math.abs(dx) > SWIPE_PX)) {
        clearTimeout(holdTimer.current);
        holdTimer.current = null;
        swiped.current = true;
        toggleMode();
      }
      return;
    }
    const p = phaseRef.current;
    if (p !== 'recording' && p !== 'starting') return;
    setSlideX(Math.min(0, dx));
    setLift(Math.min(0, dy));
    if (dx < -CANCEL_PX) cancelRecording();
    else if (dy < -LOCK_PX) {
      startRef.current = null;
      setLift(0);
      setSlideX(0);
      setPhase('locked');
      navigator.vibrate?.(10);
    }
  };

  const onPointerUp = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
      startRef.current = null;
      if (!swiped.current) toggleMode();
      return;
    }
    if (!startRef.current) return;
    startRef.current = null;
    const p = phaseRef.current;
    if (p === 'starting') {
      // Палец отпустили, пока браузер спрашивал разрешение: записи не будет.
      recRef.current?.cancel();
      recRef.current = null;
      setPhase('idle');
      resetVisuals();
    } else if (p === 'recording') {
      void finish();
    }
  };

  const onPointerCancel = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    startRef.current = null;
    const p = phaseRef.current;
    if (p === 'recording' || p === 'starting') cancelRecording();
  };

  const active = phase === 'starting' || phase === 'recording' || phase === 'locked';
  const locked = phase === 'locked';
  const max = MAX_SECONDS[mode];

  return (
    <>
      <span className="relative shrink-0">
        {hint && !active && (
          <span className="pointer-events-none absolute bottom-full right-0 z-30 mb-2 animate-fadeIn whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-surface shadow-pop">
            {hint}
          </span>
        )}
        <button
          ref={btnRef}
          type="button"
          data-no-swipe-back
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            // С клавиатуры: пробел/Enter переключает режим (запись — удержанием мыши или пальцем).
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              toggleMode();
            }
          }}
          disabled={phase === 'sending'}
          aria-label={mode === 'voice' ? 'Голосовое сообщение: удерживайте, чтобы записать. Свайп или нажатие — переключить на кружок' : 'Видео-кружок: удерживайте, чтобы записать. Свайп или нажатие — переключить на голосовое'}
          title={mode === 'voice' ? 'Удерживайте — голосовое · нажмите — кружок' : 'Удерживайте — кружок · нажмите — голосовое'}
          className="btn-primary h-11 w-11 shrink-0 touch-none select-none rounded-full px-0 md:h-8 md:w-8 md:rounded-lg"
          style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
        >
          {phase === 'sending' ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <span key={mode} className="flex animate-popIn">
              {mode === 'voice' ? <Mic size={17} /> : <RoundIcon size={17} />}
            </span>
          )}
        </button>
      </span>

      {active && rects && typeof document !== 'undefined' &&
        createPortal(
          <RecordingOverlay
            mode={mode}
            rects={rects}
            locked={locked}
            starting={phase === 'starting'}
            elapsed={elapsed}
            max={max}
            level={level}
            slideX={slideX}
            lift={lift}
            videoRef={videoRef}
            onCancel={cancelRecording}
            onSend={() => void finish()}
          />,
          document.body,
        )}
    </>
  );
}

function RecordingOverlay({
  mode,
  rects,
  locked,
  starting,
  elapsed,
  max,
  level,
  slideX,
  lift,
  videoRef,
  onCancel,
  onSend,
}: {
  mode: RecordKind;
  rects: Rects;
  locked: boolean;
  starting: boolean;
  elapsed: number;
  max: number;
  level: number;
  slideX: number;
  lift: number;
  videoRef: React.RefObject<HTMLVideoElement>;
  onCancel: () => void;
  onSend: () => void;
}) {
  const { bar, btn } = rects;
  const big = 84;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 390;
  // Центр — под пальцем, но круг целиком на экране.
  const cx = Math.min(btn.left + btn.width / 2, vw - big / 2 - 6);
  const cy = btn.top + btn.height / 2;
  const tenth = Math.floor((elapsed * 10) % 10);
  const circle = Math.min(300, vw * 0.78, Math.max(160, bar.top - 120));
  const ringR = circle / 2 + 8;
  const ringC = 2 * Math.PI * ringR;
  const progress = Math.min(1, elapsed / max);
  const cancelOpacity = Math.max(0, 1 - Math.abs(slideX) / CANCEL_PX);

  return (
    <div className="fixed inset-0 z-[65] select-none" data-no-swipe-back style={{ pointerEvents: locked ? 'auto' : 'none' }}>
      {mode === 'round' && (
        <div className="absolute inset-0 animate-fadeIn bg-surface/90 backdrop-blur-sm">
          <div
            className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-3"
            style={{ top: Math.max(16, (bar.top - circle - 60) / 2) }}
          >
            <span className="relative block animate-popIn" style={{ width: circle + 24, height: circle + 24 }}>
              <svg className="absolute inset-0 -rotate-90" width={circle + 24} height={circle + 24} aria-hidden>
                <circle cx={(circle + 24) / 2} cy={(circle + 24) / 2} r={ringR} fill="none" stroke="rgb(var(--line) / 0.12)" strokeWidth={4} />
                <circle
                  cx={(circle + 24) / 2}
                  cy={(circle + 24) / 2}
                  r={ringR}
                  fill="none"
                  stroke="#DC2626"
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeDasharray={`${ringC * progress} ${ringC}`}
                />
              </svg>
              <span className="absolute overflow-hidden rounded-full bg-[#2A2D3A]" style={{ left: 12, top: 12, width: circle, height: circle }}>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video ref={videoRef} muted playsInline autoPlay className="h-full w-full -scale-x-100 object-cover" />
                {starting && (
                  <span className="absolute inset-0 flex items-center justify-center text-white/70">
                    <Loader2 size={24} className="animate-spin" />
                  </span>
                )}
              </span>
            </span>
            <span className="text-[13px] text-ink-muted">Кружок — до {max} секунд</span>
          </div>
        </div>
      )}

      {/* Панель записи — ровно на месте поля ввода. */}
      <div
        className="absolute flex items-center gap-3 rounded-xl border border-line/[0.1] bg-surface-raised px-3 shadow-xs"
        style={{ left: bar.left, top: bar.top, width: bar.width, height: bar.height }}
      >
        <span className="flex shrink-0 items-center gap-2 text-sm font-medium tabular-nums text-ink">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[#DC2626]" />
          {starting ? '0:00' : `${formatDuration(elapsed)}${locked ? '' : `,${tenth}`}`}
        </span>
        {locked ? (
          <button type="button" onClick={onCancel} className="mx-auto flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-danger hover:bg-danger/10">
            <Trash2 size={15} />
            Отмена
          </button>
        ) : (
          <span
            className="mx-auto flex items-center gap-1 whitespace-nowrap pr-12 text-sm text-ink-muted"
            style={{ transform: `translateX(${slideX * 0.6}px)`, opacity: cancelOpacity }}
          >
            <ChevronLeft size={16} />
            Влево — отмена
          </span>
        )}
      </div>

      {/* Замок: тянуть вверх — запись без рук. */}
      {!locked && (
        <span
          className="absolute flex w-11 flex-col items-center justify-between rounded-full bg-surface-raised py-3 text-ink-muted shadow-pop"
          style={{ left: cx - 22, top: cy - big / 2 - 108 + Math.max(lift, -LOCK_PX) * 0.5, height: 88 }}
          aria-hidden
        >
          <Lock size={16} />
          <ChevronUp size={16} className="animate-bounce opacity-60" />
        </span>
      )}

      {/* Большая кнопка под пальцем; «дышит» в такт голосу. */}
      <span className="absolute" style={{ left: cx - big / 2, top: cy - big / 2, width: big, height: big }}>
        <span
          className="absolute inset-0 rounded-full bg-accent/20 transition-transform duration-75"
          style={{ transform: `scale(${1.08 + level * 0.45})` }}
          aria-hidden
        />
        {locked ? (
          <button
            type="button"
            onClick={onSend}
            aria-label="Отправить запись"
            className="absolute inset-0 flex animate-popIn items-center justify-center rounded-full bg-accent text-white shadow-pop"
          >
            <Send size={26} />
          </button>
        ) : (
          <span className="absolute inset-0 flex animate-popIn items-center justify-center rounded-full bg-accent text-white shadow-pop">
            {mode === 'voice' ? <Mic size={28} /> : <RoundIcon size={28} />}
          </span>
        )}
      </span>
    </div>
  );
}
