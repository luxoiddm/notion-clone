import type { Config } from 'tailwindcss';

// Design tokens — "Linear / Notion premium".
// Все цвета берутся из CSS-переменных в app/globals.css (светлая и тёмная
// тема), здесь только привязка к именам Tailwind. Палитру акцента
// переопределяет AccentColorApplier из пользовательских настроек.
//
// surface        — основной фон контента
// surface-panel  — фон сайдбаров/панелей
// surface-hover  — ховер строк и ghost-кнопок
// surface-raised — карточки, поповеры, диалоги (чуть «выше» фона)
// ink / muted / faint — три уровня текста
// accent / accent-soft / accent-ink — акцент, его подложка, текст на подложке
// line           — базовый цвет обводок (используется с прозрачностью)

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './hooks/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          panel: 'rgb(var(--surface-panel) / <alpha-value>)',
          hover: 'rgb(var(--surface-hover) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
          sunken: 'rgb(var(--surface-sunken) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          faint: 'rgb(var(--ink-faint) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          soft: 'rgb(var(--accent-soft) / <alpha-value>)',
          ink: 'rgb(var(--accent-ink) / <alpha-value>)',
        },
        line: 'rgb(var(--line) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '16px' }],
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['13.5px', { lineHeight: '20px' }],
        base: ['15px', { lineHeight: '24px' }],
      },
      borderRadius: {
        DEFAULT: '6px',
        md: '7px',
        lg: '10px',
        xl: '14px',
        '2xl': '18px',
      },
      boxShadow: {
        xs: '0 1px 2px rgb(0 0 0 / 0.05)',
        panel: 'var(--shadow-panel)',
        pop: 'var(--shadow-pop)',
        dialog: 'var(--shadow-dialog)',
        ring: '0 0 0 3px rgb(var(--accent) / 0.18)',
      },
      keyframes: {
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        fadeIn: { from: { opacity: '0', transform: 'translateY(2px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        popIn: { from: { opacity: '0', transform: 'scale(0.97) translateY(2px)' }, to: { opacity: '1', transform: 'scale(1) translateY(0)' } },
        overlayIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideIn: { from: { transform: 'translateX(-8px)', opacity: '0' }, to: { transform: 'translateX(0)', opacity: '1' } },
      },
      animation: {
        shimmer: 'shimmer 1.6s linear infinite',
        fadeIn: 'fadeIn 0.18s ease-out',
        popIn: 'popIn 0.16s cubic-bezier(0.16, 1, 0.3, 1)',
        overlayIn: 'overlayIn 0.15s ease-out',
        slideIn: 'slideIn 0.18s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
