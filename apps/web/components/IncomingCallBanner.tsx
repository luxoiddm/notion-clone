'use client';

import { useRouter } from 'next/navigation';
import { Phone, PhoneOff } from 'lucide-react';
import { useCall } from './CallProvider';

export function IncomingCallBanner() {
  const { incomingCall, activeCall, joinIncomingCall, declineIncomingCall } = useCall();
  const router = useRouter();

  if (!incomingCall) return null;

  const blockedByOtherCall = !!activeCall && activeCall.chatId !== incomingCall.chatId;

  const handleJoin = async () => {
    await joinIncomingCall();
    router.push(`/chat?open=${incomingCall.chatId}`);
  };

  return (
    <div className="animate-popIn fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-line/10 bg-surface-panel px-4 py-3 shadow-panel">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Phone size={16} />
      </span>
      <div className="text-sm">
        <div className="font-medium text-ink">{incomingCall.fromUserDisplayName} звонит</div>
        {blockedByOtherCall && <div className="text-xs text-ink-muted">Сначала завершите текущий звонок</div>}
      </div>
      <button
        type="button"
        onClick={() => void handleJoin()}
        disabled={blockedByOtherCall}
        className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
      >
        Присоединиться
      </button>
      <button
        type="button"
        onClick={declineIncomingCall}
        title="Отклонить"
        className="rounded-md border border-line/10 p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink"
      >
        <PhoneOff size={14} />
      </button>
    </div>
  );
}
