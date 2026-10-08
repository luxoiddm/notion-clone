'use client';

import { useRef, useState } from 'react';
import { LogOut } from 'lucide-react';

const ACTION_W = 88;

/**
 * Строка списка со свайпом влево (только на сенсорных экранах): под ней
 * открывается красная кнопка действия — например, «Выйти» из чата. На
 * компьютере ведёт себя как обычный элемент списка.
 */
export function SwipeRow({ children, onAction, actionLabel }: { children: React.ReactNode; onAction: () => void; actionLabel: string }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; base: number; locked: 'x' | 'y' | null } | null>(null);

  return (
    <li className="relative overflow-hidden rounded-lg">
      {(dx !== 0 || dragging) && (
      <button
        type="button"
        onClick={() => {
          setDx(0);
          onAction();
        }}
        className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-1 bg-danger text-xs font-medium text-white md:hidden"
        style={{ width: ACTION_W }}
      >
        <LogOut size={18} />
        {actionLabel}
      </button>
      )}
      <div
        onTouchStart={(e) => {
          const t = e.touches[0]!;
          start.current = { x: t.clientX, y: t.clientY, base: dx, locked: null };
        }}
        onTouchMove={(e) => {
          const s = start.current;
          if (!s) return;
          const t = e.touches[0]!;
          const mx = t.clientX - s.x;
          const my = t.clientY - s.y;
          if (!s.locked) {
            if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
            s.locked = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
          }
          if (s.locked !== 'x') return;
          setDragging(true);
          setDx(Math.max(-ACTION_W, Math.min(0, s.base + mx)));
        }}
        onTouchEnd={() => {
          if (start.current?.locked === 'x') setDx((v) => (v < -ACTION_W / 2 ? -ACTION_W : 0));
          start.current = null;
          setDragging(false);
        }}
        onClickCapture={(e) => {
          // Открытый свайп: первое касание его закрывает, а не открывает чат.
          if (dx !== 0) {
            e.preventDefault();
            e.stopPropagation();
            setDx(0);
          }
        }}
        style={{ transform: `translateX(${dx}px)`, transition: dragging ? 'none' : 'transform .2s ease' }}
        className="relative"
      >
        {children}
      </div>
    </li>
  );
}
