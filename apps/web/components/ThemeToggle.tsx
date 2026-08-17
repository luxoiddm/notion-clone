'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun, Monitor } from 'lucide-react';
import clsx from 'clsx';

const OPTIONS = [
  { value: 'light', icon: Sun, label: 'Светлая' },
  { value: 'system', icon: Monitor, label: 'Системная' },
  { value: 'dark', icon: Moon, label: 'Тёмная' },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className="h-7 w-24" />;

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-line/10 bg-surface-panel p-0.5">
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={clsx(
            'rounded-md p-1.5 transition-colors',
            theme === value ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
          )}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
