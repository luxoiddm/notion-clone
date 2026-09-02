export interface CoverColorPreset {
  key: string;
  label: string;
  light: string;
  dark: string;
}

// Dark presets — deliberately similar in spirit across both themes (a
// cover banner is a bold accent element, not meant to blend into
// whatever theme happens to be active), just a touch deeper for dark
// mode so it doesn't sit at nearly the same lightness as the
// surrounding dark UI and read as flat.
const DARK_PRESETS: CoverColorPreset[] = [
  { key: 'charcoal', label: 'Графит', light: '#1e293b', dark: '#0f172a' },
  { key: 'navy', label: 'Тёмно-синий', light: '#1e3a5f', dark: '#152a45' },
  { key: 'forest', label: 'Лес', light: '#1e3a2f', dark: '#152a22' },
  { key: 'teal', label: 'Бирюза', light: '#0f3d3e', dark: '#0a2c2d' },
  { key: 'plum', label: 'Слива', light: '#3a2a4d', dark: '#2a1e38' },
  { key: 'wine', label: 'Бордо', light: '#4a1f2b', dark: '#38171f' },
  { key: 'rust', label: 'Ржавчина', light: '#4a2f1a', dark: '#382413' },
  { key: 'ink', label: 'Чернила', light: '#111827', dark: '#0a0f1a' },
];

// Soft/light presets — meaningfully different per theme: a pale pastel
// for light mode (blends with a mostly-white page), a muted deep
// version of the *same hue* for dark mode (a pale pastel patch would
// read as a jarringly bright hole in an otherwise dark screen) — not
// literally the same value in both, and not just a darkened pastel
// either, closer to that hue's own dark-preset counterpart above.
const SOFT_PRESETS: CoverColorPreset[] = [
  { key: 'sky', label: 'Небо', light: '#dbeafe', dark: '#1e3a5f' },
  { key: 'mint', label: 'Мята', light: '#d1fae5', dark: '#0f3d3e' },
  { key: 'sand', label: 'Песок', light: '#fef3c7', dark: '#4a3a1a' },
  { key: 'peach', label: 'Персик', light: '#fed7aa', dark: '#4a2f1a' },
  { key: 'blush', label: 'Румянец', light: '#fce7f3', dark: '#4a1f2b' },
  { key: 'lavender', label: 'Лаванда', light: '#e9d5ff', dark: '#3a2a4d' },
  { key: 'sage', label: 'Шалфей', light: '#e2e8d5', dark: '#1e3a2f' },
  { key: 'cloud', label: 'Облако', light: '#f1f5f9', dark: '#111827' },
];

export const COVER_COLOR_PRESETS: CoverColorPreset[] = [...DARK_PRESETS, ...SOFT_PRESETS];

/** `color:{presetKey}` for a solid cover, distinguished from an image-asset URL by this prefix — same convention as PageMeta.icon (emoji vs tile-set URL). */
export function isCoverColor(coverImage: string): boolean {
  return coverImage.startsWith('color:');
}

/**
 * Resolves a stored `color:...` value to the actual hex for the current
 * theme. Handles both the current format (`color:{presetKey}`, looked
 * up against COVER_COLOR_PRESETS for the light/dark variant) and the
 * raw-hex format this feature originally shipped with in 1.33.0/1.33.1
 * (`color:#RRGGBB`) for any cover already saved under that scheme —
 * used as-is regardless of theme, the same single value it's always
 * been, since there's no preset to resolve two variants from.
 */
export function resolveCoverColorHex(coverImage: string, isDarkTheme: boolean): string {
  const value = coverImage.slice('color:'.length);
  if (value.startsWith('#')) return value;
  const preset = COVER_COLOR_PRESETS.find((p) => p.key === value);
  if (!preset) return '#1e293b'; // Unknown/corrupted key — falls back to the original default rather than rendering nothing.
  return isDarkTheme ? preset.dark : preset.light;
}

/**
 * WCAG relative luminance → picks readable title text color for a solid
 * cover color. Needed once the palette grew soft/light presets
 * alongside the original dark ones — white text (the only option
 * before) is unreadable on `sand`/`cloud`/etc. Image covers don't call
 * this at all; they always get white text, since the gradient overlay
 * already guarantees a dark enough area behind it regardless of the
 * photo's own brightness.
 */
export function textColorForCover(hex: string): 'white' | 'dark' {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > 0.5 ? 'dark' : 'white';
}
