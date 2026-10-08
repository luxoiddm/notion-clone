'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, Pause, X, VolumeX } from 'lucide-react';
import { type ChatAttachment } from '../lib/api';
import { claimPlayback, formatDuration } from '../lib/mediaRecorder';

const BARS = 36;

/** Если волны нет (старое сообщение) — ровная «псевдоволна» из адреса, чтобы пузырь не был пустым. */
function fallbackWave(seed: string): number[] {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Array.from({ length: BARS }, (_, i) => {
    h = (h * 1103515245 + 12345) | 0;
    return 0.25 + (((h >>> 16) & 0xff) / 255) * 0.5 * (0.6 + 0.4 * Math.sin(i / 3));
  });
}

function resample(w: number[], n: number): number[] {
  if (w.length === n) return w;
  return Array.from({ length: n }, (_, i) => {
    const from = Math.floor((i * w.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * w.length) / n));
    let m = 0;
    for (let j = from; j < to; j++) m = Math.max(m, w[j] ?? 0);
    return m;
  });
}

/**
 * Голосовое в пузыре: кнопка, волна (прослушанное закрашено, по волне
 * можно перемотать) и время. Одновременно играет только одно сообщение.
 */
export function VoiceMessage({ attachment, isMine }: { attachment: ChatAttachment; isMine: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const duration = attachment.duration ?? mediaDuration ?? 0;
  const bars = useMemo(
    () => resample(attachment.waveform?.length ? attachment.waveform : fallbackWave(attachment.url), BARS),
    [attachment.waveform, attachment.url],
  );
  const progress = duration ? Math.min(1, current / duration) : 0;

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      claimPlayback(a);
      if (duration && a.currentTime >= duration - 0.05) a.currentTime = 0;
      void a.play().catch(() => setPlaying(false));
    } else a.pause();
  };

  const seek = (e: React.MouseEvent<HTMLSpanElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    a.currentTime = f * duration;
    setCurrent(a.currentTime);
    if (a.paused) toggle();
  };

  return (
    <div className="flex w-[232px] max-w-full items-center gap-2.5 py-0.5">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={attachment.url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setMediaDuration(d);
        }}
        className="hidden"
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Пауза' : 'Слушать голосовое'}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors ${
          isMine ? 'bg-accent text-white hover:bg-accent/90' : 'bg-accent-soft text-accent-ink hover:bg-accent/20'
        }`}
      >
        {playing ? <Pause size={17} fill="currentColor" strokeWidth={0} /> : <Play size={17} fill="currentColor" strokeWidth={0} className="ml-0.5" />}
      </button>
      <span className="min-w-0 flex-1">
        <span
          role="slider"
          tabIndex={-1}
          aria-label="Перемотка"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          onClick={seek}
          className="flex h-7 cursor-pointer items-center gap-[2px]"
        >
          {bars.map((v, i) => (
            <span
              key={i}
              className={`w-[3px] shrink-0 rounded-full ${i / BARS < progress ? 'bg-accent' : isMine ? 'bg-accent/35' : 'bg-ink/20'}`}
              style={{ height: `${Math.round(4 + v * 22)}px` }}
            />
          ))}
        </span>
        <span className="block text-[11px] tabular-nums text-ink-muted">{formatDuration(playing || current ? current : duration)}</span>
      </span>
    </div>
  );
}

/**
 * Кружок в ленте: круглое превью без звука (крутится, пока виден на
 * экране), длительность снизу. Нажатие — открыть крупно со звуком.
 */
export function RoundVideoMessage({ attachment }: { attachment: ChatAttachment }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const duration = attachment.duration ?? mediaDuration ?? 0;

  useEffect(() => {
    const v = videoRef.current;
    if (!v || open) {
      v?.pause();
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void v.play().catch(() => undefined);
        else v.pause();
      },
      { threshold: 0.5 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Кружок ${formatDuration(duration)} — открыть со звуком`}
        className="relative mt-0.5 block h-[200px] w-[200px] max-w-[56vw] max-h-[56vw] overflow-hidden rounded-full bg-surface-sunken shadow-xs"
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={`${attachment.url}#t=0.1`}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setMediaDuration(d);
          }}
          className="h-full w-full object-cover"
        />
        <span className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white">
          <VolumeX size={11} />
          {formatDuration(duration)}
        </span>
      </button>
      {open && <RoundVideoModal attachment={attachment} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Просмотр кружка: крупный круг по центру поверх чата, белое кольцо — прогресс, нажатие — пауза. */
function RoundVideoModal({ attachment, onClose }: { attachment: ChatAttachment; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [time, setTime] = useState(0);
  const duration = attachment.duration ?? 0;

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      claimPlayback(v);
      void v.play().catch(() => setPaused(true));
    }
    let raf = 0;
    const tick = () => {
      const el = videoRef.current;
      if (el) {
        const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;
        setTime(el.currentTime);
        setProgress(d ? Math.min(1, el.currentTime / d) : 0);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, duration]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      claimPlayback(v);
      void v.play();
    } else v.pause();
  };

  if (typeof document === 'undefined') return null;
  const size = 'min(360px, 86vw)';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр кружка"
      onClick={onClose}
      className="fixed inset-0 z-[60] flex animate-fadeIn flex-col items-center justify-center gap-5 bg-black/75 backdrop-blur-sm"
      data-no-swipe-back
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Закрыть"
        className="absolute right-3 top-[max(12px,env(safe-area-inset-top))] flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
      >
        <X size={20} />
      </button>
      <button
        type="button"
        onClick={toggle}
        aria-label={paused ? 'Продолжить' : 'Пауза'}
        className="relative animate-popIn rounded-full"
        style={{ width: size, height: size }}
      >
        <svg viewBox="0 0 100 100" className="absolute -inset-[10px] h-[calc(100%+20px)] w-[calc(100%+20px)] -rotate-90" aria-hidden>
          <circle cx="50" cy="50" r="48.5" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="1.2" />
          <circle
            cx="50"
            cy="50"
            r="48.5"
            fill="none"
            stroke="#fff"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 48.5 * progress} ${2 * Math.PI * 48.5}`}
          />
        </svg>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={attachment.url}
          playsInline
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onEnded={onClose}
          className="h-full w-full rounded-full bg-black object-cover"
        />
        {paused && (
          <span className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white">
            <Play size={28} fill="currentColor" strokeWidth={0} className="ml-1" />
          </span>
        )}
      </button>
      <span className="text-[13px] tabular-nums text-white/75" onClick={(e) => e.stopPropagation()}>
        {formatDuration(time)} из {formatDuration(duration || time)}
      </span>
    </div>,
    document.body,
  );
}
