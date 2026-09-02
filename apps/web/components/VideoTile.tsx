'use client';

import { useEffect, useRef } from 'react';
import { MicOff, VideoOff } from 'lucide-react';

export function VideoTile({
  stream,
  muted,
  label,
  cameraOff,
  micOff,
  fill,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  label: string;
  /**
   * Only meaningful for the local tile — WebRTC gives no reliable,
   * cross-browser way to learn whether a *remote* peer's camera/mic is
   * currently disabled (`MediaStreamTrack.enabled` is a local-only
   * signal, not relayed to the receiving side), so remote tiles just
   * render whatever frames actually arrive instead of a placeholder.
   */
  cameraOff?: boolean;
  micOff?: boolean;
  /** Fills the parent container (`h-full w-full`) instead of the default fixed `h-40` box — for contexts where the *parent* dictates size (the full-screen remote view and PiP thumbnail in the mobile private-call layout), not this component's own fixed dimensions. */
  fill?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  const showPlaceholder = !stream || cameraOff;

  return (
    <div
      className={
        fill
          ? 'relative h-full w-full overflow-hidden bg-surface-panel'
          : 'relative aspect-video h-40 shrink-0 overflow-hidden rounded-lg border border-line/10 bg-surface-panel'
      }
    >
      {/* Always mounted, even while the placeholder below covers it —
          conditionally swapping this <video> in and out of the tree
          (e.g. only rendering it when !showPlaceholder) would unmount and
          later remount it, but the useEffect above only re-attaches
          srcObject when `stream` itself changes, not on every remount.
          That's exactly what broke "turn camera back on": toggling off
          unmounted <video>, toggling on mounted a *new* one with the same
          `stream` reference — so the effect never re-ran, and the fresh
          element's srcObject was simply never set. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`h-full w-full object-cover ${showPlaceholder ? 'hidden' : ''}`}
      />
      {showPlaceholder && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-ink-faint">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-hover text-sm font-medium text-ink-muted">
            {label.slice(0, 1).toUpperCase()}
          </span>
          {!stream && <span className="text-xs">Подключение...</span>}
        </div>
      )}

      <span className="absolute bottom-1 left-1.5 flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 text-[11px] text-white">
        {micOff && <MicOff size={11} />}
        {label}
      </span>
      {cameraOff && stream && <VideoOff size={12} className="absolute right-1.5 top-1.5 text-white/70" />}
    </div>
  );
}
