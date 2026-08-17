'use client';

import { Mic, MicOff, Video, VideoOff, PhoneOff, MonitorUp, MonitorX } from 'lucide-react';

export function CallControls({
  micEnabled,
  cameraEnabled,
  isScreenSharing,
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
}: {
  micEnabled: boolean;
  cameraEnabled: boolean;
  isScreenSharing: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2 border-t border-line/10 bg-surface-panel px-4 py-2">
      <button
        type="button"
        onClick={onToggleMic}
        title={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
        className={`rounded-full p-2 ${micEnabled ? 'bg-surface text-ink-muted hover:bg-surface-hover' : 'bg-red-500/15 text-red-500 hover:bg-red-500/25'}`}
      >
        {micEnabled ? <Mic size={16} /> : <MicOff size={16} />}
      </button>

      <button
        type="button"
        onClick={onToggleCamera}
        title={cameraEnabled ? 'Выключить камеру' : 'Включить камеру'}
        className={`rounded-full p-2 ${cameraEnabled ? 'bg-surface text-ink-muted hover:bg-surface-hover' : 'bg-red-500/15 text-red-500 hover:bg-red-500/25'}`}
      >
        {cameraEnabled ? <Video size={16} /> : <VideoOff size={16} />}
      </button>

      <button
        type="button"
        onClick={onToggleScreenShare}
        title={isScreenSharing ? 'Остановить демонстрацию экрана' : 'Демонстрация экрана'}
        className={`rounded-full p-2 ${isScreenSharing ? 'bg-accent-soft text-accent hover:opacity-90' : 'bg-surface text-ink-muted hover:bg-surface-hover'}`}
      >
        {isScreenSharing ? <MonitorX size={16} /> : <MonitorUp size={16} />}
      </button>

      <button
        type="button"
        onClick={onLeave}
        title="Завершить звонок"
        className="rounded-full bg-red-500 p-2 text-white hover:opacity-90"
      >
        <PhoneOff size={16} />
      </button>
    </div>
  );
}
