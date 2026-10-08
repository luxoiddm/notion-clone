'use client';

import { useRouter } from 'next/navigation';
import { Phone, PhoneOff, MessageSquare } from 'lucide-react';
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

  const handleMessage = () => {
    declineIncomingCall();
    router.push(`/chat?open=${incomingCall.chatId}`);
  };

  const initials = incomingCall.fromUserDisplayName
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <>
      {/* Телефон: входящий звонок на весь экран, кнопки «Отклонить»/«Ответить» внизу под пальцем. */}
      <div
        role="dialog"
        aria-label={`${incomingCall.fromUserDisplayName} звонит`}
        className="fixed inset-0 z-[70] flex animate-fadeIn flex-col items-center bg-[#141418] px-10 text-white md:hidden"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 96px)', paddingBottom: 'calc(var(--safe-bottom) + 48px)' }}
      >
        <span className="relative flex h-40 w-40 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full border-2 border-[#7C86F0]/40 [animation-duration:2s]" />
          <span className="absolute inset-3 rounded-full border-2 border-[#7C86F0]/60" />
          <span className="flex h-28 w-28 items-center justify-center rounded-full bg-[#2B2F5E] text-4xl font-semibold text-[#C7CBFF]">{initials}</span>
        </span>
        <h2 className="mt-7 text-center text-[28px] font-bold leading-tight">{incomingCall.fromUserDisplayName}</h2>
        <p className="mt-1 text-white/70">{blockedByOtherCall ? 'Сначала завершите текущий звонок' : 'Входящий звонок'}</p>

        <div className="mt-auto flex w-full flex-col gap-10">
          <div className="flex justify-center">
            <button type="button" onClick={handleMessage} className="flex flex-col items-center gap-2 text-[13px] text-white/75">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.12]">
                <MessageSquare size={22} />
              </span>
              Сообщение
            </button>
          </div>
          <div className="flex justify-between">
            <button type="button" onClick={declineIncomingCall} className="flex flex-col items-center gap-2 text-[13px] text-white/75">
              <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-[#DC2626]">
                <PhoneOff size={28} />
              </span>
              Отклонить
            </button>
            <button
              type="button"
              onClick={() => void handleJoin()}
              disabled={blockedByOtherCall}
              className="flex flex-col items-center gap-2 text-[13px] text-white/75 disabled:opacity-40"
            >
              <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-[#15803D]">
                <Phone size={28} />
              </span>
              Ответить
            </button>
          </div>
        </div>
      </div>

      {/* Компьютер: плашка внизу экрана. */}
      <div className="animate-popIn fixed bottom-5 left-1/2 z-50 hidden -translate-x-1/2 items-center gap-3 rounded-2xl bg-surface-raised px-4 py-3 shadow-dialog md:flex">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Phone size={16} />
        </span>
        <div className="text-sm">
          <div className="font-medium text-ink">{incomingCall.fromUserDisplayName} звонит</div>
          {blockedByOtherCall && <div className="text-xs text-ink-muted">Сначала завершите текущий звонок</div>}
        </div>
        <button type="button" onClick={() => void handleJoin()} disabled={blockedByOtherCall} className="btn-primary bg-success hover:bg-success/90">
          Присоединиться
        </button>
        <button type="button" onClick={declineIncomingCall} title="Отклонить" aria-label="Отклонить" className="btn-icon">
          <PhoneOff size={14} />
        </button>
      </div>
    </>
  );
}
