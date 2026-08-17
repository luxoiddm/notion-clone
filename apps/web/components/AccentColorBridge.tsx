'use client';

import { useSession } from './SessionProvider';
import { AccentColorApplier } from './AccentColorApplier';

export function AccentColorBridge() {
  const { user } = useSession();
  return <AccentColorApplier accentColor={user?.accentColor ?? null} />;
}
