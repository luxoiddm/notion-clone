'use client';

import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useSession } from '../../components/SessionProvider';
import { ToastProvider } from '../../components/Toast';
import { PublicSitesSection } from '../../components/PublicSitesSection';

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
    return (
      <div className="flex h-screen items-center justify-center text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-ink-muted">
        <p>Нужно сначала войти в рабочее пространство.</p>
        <Link href="/" className="text-accent hover:underline">
          На главную
        </Link>
      </div>
    );
  }

  if (user.role !== 'Admin' && user.role !== 'Team-Lead') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-ink-muted">
        <p>Раздел доступен администраторам и тимлидам.</p>
        <Link href="/" className="text-accent hover:underline">
          На главную
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-4xl px-6 py-10 sm:px-10">
      <Link href="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft size={14} />
        Назад в рабочее пространство
      </Link>

      <h1 className="mb-1 text-2xl font-bold text-ink">Модерация</h1>
      <p className="mb-6 text-sm text-ink-muted">Публичные страницы и заявки на публикацию документов.</p>

      <PublicSitesSection />
    </div>
  );
}
