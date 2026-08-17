import type { Config } from 'tailwindcss';

// Design tokens
// Light surface:  #FFFFFF / #F7F7F5 (panel)   Dark surface: #191919 / #202020 (panel)
// Text:           #1F1F1F (light) / #E9E9E7 (dark)
// Muted text:     #8A8A86
// Accent:         #2F6FEF (links, active states, focus ring) — a working blue,
//                 deliberately not the cream+terracotta combination.
// Border:         rgba(0,0,0,0.08) light / rgba(255,255,255,0.09) dark

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './hooks/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          panel: 'rgb(var(--surface-panel) / <alpha-value>)',
          hover: 'rgb(var(--surface-hover) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          faint: 'rgb(var(--ink-faint) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          soft: 'rgb(var(--accent-soft) / <alpha-value>)',
        },
        line: 'rgb(var(--line) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
      },
      keyframes: {
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        fadeIn: { from: { opacity: '0', transform: 'translateY(2px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        popIn: { from: { opacity: '0', transform: 'scale(0.97)' }, to: { opacity: '1', transform: 'scale(1)' } },
      },
      animation: {
        shimmer: 'shimmer 1.6s linear infinite',
        fadeIn: 'fadeIn 0.15s ease-out',
        popIn: 'popIn 0.12s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
