'use client';

import { useEffect } from 'react';
import { useTheme } from 'next-themes';
import { findAccentPreset } from '../lib/accentPalette';

/**
 * Every accent-colored element in the app (buttons, links, own chat
 * bubbles, focus rings) already renders via the `--accent`/`--accent-soft`
 * CSS custom properties (see globals.css) rather than a hardcoded color —
 * so a personal color preference can be applied *once*, here, instead of
 * hunting down every individual Tailwind class that happens to reference
 * the accent color.
 */
export function AccentColorApplier({ accentColor }: { accentColor: string | null }) {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const root = document.documentElement;
    const preset = findAccentPreset(accentColor);

    if (!preset) {
      // No preference (or an unrecognized/legacy key) — remove any
      // previous override so globals.css's own :root/.dark values win,
      // rather than leaving a stale inline color in place.
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-soft');
      return;
    }

    const variant = resolvedTheme === 'dark' ? preset.dark : preset.light;
    root.style.setProperty('--accent', variant.accent);
    root.style.setProperty('--accent-soft', variant.accentSoft);
  }, [accentColor, resolvedTheme]);

  return null;
}
