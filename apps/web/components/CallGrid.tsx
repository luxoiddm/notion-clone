'use client';

import { VideoTile } from './VideoTile';

export interface CallGridTile {
  userId: string;
  stream: MediaStream | null;
  label: string;
  isLocal?: boolean;
  cameraOff?: boolean;
  micOff?: boolean;
}

export function CallGrid({ tiles }: { tiles: CallGridTile[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {tiles.map((tile) => (
        <VideoTile
          key={tile.userId}
          stream={tile.stream}
          muted={tile.isLocal}
          label={tile.label}
          cameraOff={tile.cameraOff}
          micOff={tile.micOff}
        />
      ))}
    </div>
  );
}
