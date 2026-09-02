'use client';

import { CallControls } from './CallControls';
import { VideoTile } from './VideoTile';

export function MobilePrivateCallScreen({
  remoteStream,
  remoteLabel,
  localStream,
  localCameraOff,
  isScreenSharing,
  micEnabled,
  cameraEnabled,
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
}: {
  remoteStream: MediaStream | null;
  remoteLabel: string;
  /** Already resolved by the caller to whichever stream should actually show locally — the screen share while presenting, the camera otherwise. Same source CallGrid's own local tile already uses. */
  localStream: MediaStream | null;
  localCameraOff: boolean;
  isScreenSharing: boolean;
  micEnabled: boolean;
  cameraEnabled: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onLeave: () => void;
}) {
  return (
    // md:hidden — this whole screen is mobile-only; the desktop layout
    // (compact grid above the chat, unaffected by any of this) keeps
    // rendering underneath but stays invisible on a narrow viewport
    // purely through this one class, no separate conditional needed at
    // the call site beyond "is this a private call".
    <div className="fixed inset-0 z-40 flex flex-col bg-black md:hidden">
      <div className="relative flex-1">
        <VideoTile stream={remoteStream} label={remoteLabel} fill />

        {/* Local PiP — bottom-right, Telegram-style. Fixed position, not
            draggable: dragging would be a nice touch but is a genuinely
            separate chunk of gesture-handling work, not a small addition
            to this same change. */}
        <div className="absolute bottom-28 right-4 h-32 w-24 overflow-hidden rounded-xl border-2 border-white/20 shadow-lg">
          <VideoTile stream={localStream} muted label={isScreenSharing ? 'Вы (экран)' : 'Вы'} cameraOff={!isScreenSharing && localCameraOff} fill />
        </div>
      </div>

      {/* Gradient behind the controls, not a flat background — keeps
          them legible over bright video without needing a fully opaque
          bar that would otherwise permanently crop the bottom of the
          remote video underneath it. */}
      <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/70 via-black/30 to-transparent px-4 pb-6 pt-12">
        <CallControls
          variant="overlay"
          micEnabled={micEnabled}
          cameraEnabled={cameraEnabled}
          isScreenSharing={isScreenSharing}
          onToggleMic={onToggleMic}
          onToggleCamera={onToggleCamera}
          onToggleScreenShare={onToggleScreenShare}
          onLeave={onLeave}
        />
      </div>
    </div>
  );
}
