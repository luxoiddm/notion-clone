/**
 * Text-column width for the article editor and the public page —
 * configurable via `NEXT_PUBLIC_EDITOR_WIDTH_CHARS` (character count,
 * expressed with CSS's `ch` unit: the width of the "0" glyph in the
 * container's font, a natural way to size a reading column by character
 * count rather than guessing a pixel value). 80 characters is the
 * default — a standard "comfortable line length" figure in typography,
 * not tied to the old fixed `max-w-3xl` (48rem) it replaces.
 *
 * Read once here and shared by both `components/Editor.tsx` and
 * `app/[slug]/page.tsx` (the public-page equivalent) so the two can
 * never drift out of sync with each other — same reasoning as
 * `lib/coverColors.ts`/`lib/accentPalette.ts` being a single source of
 * truth for their own settings, and the same `envPixelSize`-style
 * parsing already used for `NEXT_PUBLIC_LOGIN_LOGO_HEIGHT`/
 * `NEXT_PUBLIC_HEADER_LOGO_HEIGHT` in `SiteSettingsProvider.tsx`
 * (`Number(undefined)`/`Number('')` both fail the `> 0` check, so an
 * unset *or* empty-string env var falls through to the default instead
 * of silently rendering a 0-width column).
 *
 * Like every `NEXT_PUBLIC_*` var, this is inlined at build time — a
 * `next build` deployment needs a rebuild for a change here to take
 * effect, `next dev` picks it up on the next restart (see install.md).
 *
 * Applied via inline `style`, not a Tailwind class: the value is only
 * known at runtime from the env var, and Tailwind's build-time content
 * scanner can't pick up a dynamically-constructed class name like
 * `` `max-w-[${chars}ch]` `` — it statically greps source files for
 * literal class strings, it doesn't evaluate JS.
 */
function envCharWidth(envValue: string | undefined, fallback: number): number {
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const EDITOR_WIDTH_CHARS = envCharWidth(process.env.NEXT_PUBLIC_EDITOR_WIDTH_CHARS, 80);

/** Inline `style` object for the text-column container (editor and public page both use this directly as `style={editorWidthStyle}`) and, separately, for anything that needs just the raw CSS value (e.g. composed with other style properties). */
export const EDITOR_MAX_WIDTH = `${EDITOR_WIDTH_CHARS}ch`;
export const editorWidthStyle: { maxWidth: string } = { maxWidth: EDITOR_MAX_WIDTH };
