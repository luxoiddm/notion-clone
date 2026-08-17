import type { PresenceUser } from '../hooks/usePresence';
import { Avatar } from './Avatar';

export function PresenceAvatars({ users, currentUserId }: { users: PresenceUser[]; currentUserId: string | null }) {
  const others = users.filter((u) => u.id !== currentUserId);
  if (others.length === 0) return null;

  return (
    <div className="flex items-center -space-x-2">
      {others.slice(0, 5).map((u) => (
        <div key={u.id} title={u.displayName} className="relative rounded-full ring-2 ring-surface">
          <Avatar avatarUrl={u.avatarUrl} displayName={u.displayName} size="xs" />
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-surface bg-emerald-500" />
        </div>
      ))}
      {others.length > 5 && (
        <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-surface-hover text-[10px] text-ink-muted">
          +{others.length - 5}
        </div>
      )}
    </div>
  );
}
