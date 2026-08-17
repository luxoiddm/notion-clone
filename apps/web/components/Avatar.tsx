'use client';

import { withAuthToken } from '../lib/api';

const SIZE_CLASSES = {
  xs: 'h-5 w-5 text-[10px]',
  sm: 'h-7 w-7 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-16 w-16 text-lg',
  xl: 'h-24 w-24 text-2xl',
} as const;

export function Avatar({
  avatarUrl,
  displayName,
  size = 'sm',
  className = '',
}: {
  avatarUrl: string | null | undefined;
  displayName: string;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  const initial = displayName.trim().slice(0, 1).toUpperCase() || '?';

  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={withAuthToken(avatarUrl)}
        alt={displayName}
        className={`${SIZE_CLASSES[size]} shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <span
      className={`flex ${SIZE_CLASSES[size]} shrink-0 items-center justify-center rounded-full bg-accent-soft font-medium text-accent ${className}`}
    >
      {initial}
    </span>
  );
}
