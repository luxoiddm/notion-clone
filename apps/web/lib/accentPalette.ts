export interface AccentVariant {
  /** Space-separated RGB triple, matching the format Tailwind's rgb(var(--x) / alpha) expects — no "rgb(...)" wrapper, no commas. */
  accent: string;
  accentSoft: string;
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
    key: 'slate',
    label: 'Графит',
    light: { accent: '100 116 139', accentSoft: '226 232 240' },
    dark: { accent: '148 163 184', accentSoft: '30 41 59' },
  },
  {
    key: 'blue',
    label: 'Синий',
    light: { accent: '90 122 168', accentSoft: '224 233 245' },
    dark: { accent: '140 172 216', accentSoft: '26 37 54' },
  },
  {
    key: 'forest',
    label: 'Лес',
    light: { accent: '92 132 108', accentSoft: '222 234 225' },
    dark: { accent: '142 178 154', accentSoft: '24 38 30' },
  },
  {
    key: 'teal',
    label: 'Бирюза',
    light: { accent: '82 132 136', accentSoft: '218 234 235' },
    dark: { accent: '136 182 186', accentSoft: '20 38 40' },
  },
  {
    key: 'plum',
    label: 'Слива',
    light: { accent: '132 114 156', accentSoft: '232 227 241' },
    dark: { accent: '178 164 198', accentSoft: '34 30 46' },
  },
  {
    key: 'rose',
    label: 'Роза',
    light: { accent: '168 112 128', accentSoft: '242 226 231' },
    dark: { accent: '208 168 178', accentSoft: '42 28 33' },
  },
  {
    key: 'terracotta',
    label: 'Терракота',
    light: { accent: '166 118 96', accentSoft: '240 226 214' },
    dark: { accent: '206 166 144', accentSoft: '42 30 24' },
  },
  {
    key: 'amber',
    label: 'Янтарь',
    light: { accent: '160 134 84', accentSoft: '241 231 205' },
    dark: { accent: '204 180 132', accentSoft: '40 34 20' },
  },
];

export function findAccentPreset(key: string | null): AccentPreset | null {
  if (!key) return null;
  return ACCENT_PRESETS.find((p) => p.key === key) ?? null;
}
