'use client';

import { useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';

/** Сколько провести пальцем вправо, чтобы сработал «назад». */
const THRESHOLD = 90;
/** Быстрый короткий взмах тоже считается (px/мс). */
const FLICK_SPEED = 0.5;
const FLICK_MIN = 40;

/** Места, где горизонтальный жест нужен самому содержимому. */
const IGNORE = 'input, textarea, select, [contenteditable="true"], pre, video, [data-no-swipe-back]';

function scrollsHorizontally(el: HTMLElement | null, stop: HTMLElement): boolean {
  for (let n = el; n && n !== stop; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 2) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

/**
 * Свайп вправо по экрану = «Назад» (телефон, работа одной рукой). Дублирует
 * стрелку в шапке, до которой большим пальцем не дотянуться. Панель едет
 * за пальцем, слева появляется круглый индикатор со стрелкой; отпустили
 * дальше порога (или резко махнули) — onBack. Вертикальная прокрутка не
 * мешает: направление определяется по первым пикселям движения. На
 * компьютере (мышь) ничего не происходит — только сенсорные события.
 */
export function SwipeBack({
  enabled,
  onBack,
  className,
  children,
}: {
  enabled: boolean;
  onBack: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; t: number; axis: 'x' | 'y' | null } | null>(null);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    start.current = null;
    setDragging(false);
    setDx(0);
  };

  return (
    <div
      ref={ref}
      className={className}
      style={{
        // Вертикальную прокрутку ведёт браузер, горизонтальный жест — наш.
        touchAction: enabled ? 'pan-y' : undefined,
        transform: dx ? `translateX(${dx * 0.35}px)` : undefined,
        transition: dragging ? 'none' : 'transform .2s ease',
      }}
      onTouchStart={(e) => {
        if (!enabled || e.touches.length !== 1 || window.innerWidth >= 768) return;
        const target = e.target as HTMLElement;
        if (target.closest(IGNORE) || (ref.current && scrollsHorizontally(target, ref.current))) return;
        if (window.getSelection()?.toString()) return;
        const t = e.touches[0]!;
        start.current = { x: t.clientX, y: t.clientY, t: Date.now(), axis: null };
      }}
      onTouchMove={(e) => {
        const s = start.current;
        if (!s) return;
        const t = e.touches[0]!;
        const mx = t.clientX - s.x;
        const my = t.clientY - s.y;
        if (!s.axis) {
          if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
          s.axis = Math.abs(mx) > Math.abs(my) * 1.3 && mx > 0 ? 'x' : 'y';
          if (s.axis === 'y') {
            start.current = null;
            return;
          }
          setDragging(true);
        }
        setDx(Math.max(0, mx));
      }}
      onTouchEnd={(e) => {
        const s = start.current;
        if (!s || s.axis !== 'x') return reset();
        const t = e.changedTouches[0]!;
        const dist = t.clientX - s.x;
        const speed = dist / Math.max(1, Date.now() - s.t);
        const go = dist > THRESHOLD || (dist > FLICK_MIN && speed > FLICK_SPEED);
        reset();
        if (go) {
          navigator.vibrate?.(8);
          onBack();
        }
      }}
      onTouchCancel={reset}
    >
      {dragging && dx > 0 && (
        <span
          aria-hidden
          className="pointer-events-none fixed left-2 top-1/2 z-50 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full shadow-pop"
          style={{
            opacity: Math.min(1, dx / THRESHOLD),
            transform: `translate(${Math.min(dx, THRESHOLD) * 0.25}px, -50%) scale(${0.7 + Math.min(1, dx / THRESHOLD) * 0.3})`,
            background: dx >= THRESHOLD ? 'rgb(var(--accent))' : 'rgb(var(--surface-raised))',
            color: dx >= THRESHOLD ? '#fff' : 'rgb(var(--ink))',
          }}
        >
          <ChevronLeft size={22} />
        </span>
      )}
      {children}
    </div>
  );
}
