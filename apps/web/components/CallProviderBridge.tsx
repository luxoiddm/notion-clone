'use client';

import { useSession } from './SessionProvider';
import { CallProvider } from './CallProvider';
import { IncomingCallBanner } from './IncomingCallBanner';
import { SoundNotifier } from './SoundNotifier';

export function CallProviderBridge({ children }: { children: React.ReactNode }) {
  const { accessToken, user } = useSession();
  return (
    <CallProvider accessToken={accessToken} currentUserId={user?.id ?? null}>
      {children}
      <IncomingCallBanner />
      <SoundNotifier accessToken={accessToken} currentUserId={user?.id ?? null} />
    </CallProvider>
  );
}
