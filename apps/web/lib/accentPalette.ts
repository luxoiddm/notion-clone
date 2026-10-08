export interface AccentVariant {
  /** Space-separated RGB triple, matching the format Tailwind's rgb(var(--x) / alpha) expects — no "rgb(...)" wrapper, no commas. */
  accent: string;
  accentSoft: string;
  /** Текст поверх accentSoft (бейджи, активные пункты) — темнее акцента в светлой теме, светлее в тёмной. */
  accentInk: string;
}

export interface AccentPreset {
  key: string;
  label: string;
  light: AccentVariant;
  dark: AccentVariant;
}

/**
 * The default baseline (globals.css's own `:root`/`.dark` values) matches
 * the 'slate' preset below — a muted graphite-blue, less saturated than
 * the original pure blue. 'blue' keeps that original color available as
 * an explicit choice for anyone who preferred it.
 *
 * All of these are desaturated ("dusty") rather than pale — accent color
 * fills buttons and the sender's own chat bubble with *white* text on
 * top, so a genuinely light/pale pastel would fail contrast there. The
 * softer look comes from pulling saturation down, not lightness up.
 */
export const ACCENT_PRESETS: AccentPreset[] = [
  {
    key: 'indigo',
    label: 'Индиго',
    light: { accent: '94 106 210', accentSoft: '236 237 252', accentInk: '67 77 170' },
    dark: { accent: '104 114 224', accentSoft: '35 37 66', accentInk: '178 185 255' },
  },
  {
    key: 'slate',
    label: 'Графит',
    light: { accent: '71 85 105', accentSoft: '234 237 242', accentInk: '51 65 85' },
    dark: { accent: '100 116 139', accentSoft: '33 40 54', accentInk: '203 213 225' },
  },
  {
    key: 'blue',
    label: 'Синий',
    light: { accent: '37 99 235', accentSoft: '230 239 254', accentInk: '29 78 216' },
    dark: { accent: '59 120 240', accentSoft: '23 37 68', accentInk: '165 196 255' },
  },
  {
    key: 'forest',
    label: 'Лес',
    light: { accent: '22 128 82', accentSoft: '226 243 234', accentInk: '21 103 66' },
    dark: { accent: '30 140 90', accentSoft: '20 44 32', accentInk: '150 225 180' },
  },
  {
    key: 'teal',
    label: 'Бирюза',
    light: { accent: '13 128 140', accentSoft: '222 242 244', accentInk: '15 102 112' },
    dark: { accent: '20 135 148', accentSoft: '16 42 46', accentInk: '140 222 228' },
  },
  {
    key: 'plum',
    label: 'Слива',
    light: { accent: '124 77 196', accentSoft: '240 233 251', accentInk: '104 60 170' },
    dark: { accent: '140 95 210', accentSoft: '40 30 62', accentInk: '208 186 255' },
  },
  {
    key: 'rose',
    label: 'Роза',
    light: { accent: '205 52 98', accentSoft: '252 232 238', accentInk: '170 40 80' },
    dark: { accent: '215 65 110', accentSoft: '56 24 34', accentInk: '255 175 196' },
  },
  {
    key: 'terracotta',
    label: 'Терракота',
    light: { accent: '196 90 50', accentSoft: '251 236 228', accentInk: '160 70 38' },
    dark: { accent: '205 100 60', accentSoft: '52 30 22', accentInk: '255 190 160' },
  },
  {
    key: 'amber',
    label: 'Янтарь',
    light: { accent: '180 120 10', accentSoft: '251 241 218', accentInk: '140 92 10' },
    dark: { accent: '190 128 20', accentSoft: '48 36 14', accentInk: '250 210 130' },
  },
];

export function findAccentPreset(key: string | null): AccentPreset | null {
  if (!key) return null;
  return ACCENT_PRESETS.find((p) => p.key === key) ?? null;
}
