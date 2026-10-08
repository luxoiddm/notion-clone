'use client';

import { Globe } from 'lucide-react';
import { useSession } from '../../components/SessionProvider';
import { ToastProvider } from '../../components/Toast';
import { PublicSitesSection } from '../../components/PublicSitesSection';
import { PublicInboxSection } from '../../components/PublicInboxSection';
import { AppShell, FullScreenLoader, SignInRequired } from '../../components/AppShell';

export default function ModerationPage() {
  return (
    <ToastProvider>
      <ModerationPanel />
    </ToastProvider>
  );
}

function ModerationPanel() {
  const { user, isLoading: sessionLoading } = useSession();

  if (sessionLoading) {
    return <FullScreenLoader />;
  }

  if (!user) {
    return <SignInRequired />;
  }

  if (user.role !== 'Admin' && user.role !== 'Team-Lead') {
    return <SignInRequired message="Раздел доступен администраторам и тимлидам." />;
  }

  return (
    <AppShell
      mobileBack={{ href: '/more', label: 'Ещё' }}
      title="Публикация"
      icon={<Globe size={19} />}
      description="Публичные страницы, доступные без входа, и очередь заявок на публикацию."
      width="wide"
    >
      <PublicInboxSection />
      <PublicSitesSection />
    </AppShell>
  );
}
