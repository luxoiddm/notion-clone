'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { Check, AlertCircle, Info } from 'lucide-react';
import clsx from 'clsx';

interface Toast {
  id: string;
  message: string;
  kind: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  push: (message: string, kind?: Toast['kind']) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, kind: Toast['kind'] = 'success') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2400);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'animate-popIn pointer-events-auto flex items-center gap-2 rounded-lg border border-line/10 bg-surface-panel px-3 py-2 text-sm shadow-panel',
              t.kind === 'error' && 'text-red-500',
            )}
          >
            {t.kind === 'success' && <Check size={14} className="text-emerald-500" />}
            {t.kind === 'error' && <AlertCircle size={14} />}
            {t.kind === 'info' && <Info size={14} className="text-accent" />}
            <span className="text-ink">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
