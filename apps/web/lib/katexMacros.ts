import type { KatexOptions } from 'katex';

/**
 * Custom LaTeX macros for commands that aren't standard LaTeX/KaTeX but
 * show up in pasted formulas because they were authored in a tool with
 * its own macro definitions (Obsidian's "Math macros" setting, an
 * Overleaf preamble, etc.) — KaTeX has no way to know about those on its
 * own, so without this list `\Buy`/`\Sell`/`\sign` etc. render as a
 * visible parse error (KaTeX's own red "undefined control sequence"
 * text, shown because every `katex.renderToString` call in this app
 * uses `throwOnError: false` rather than actually throwing).
 *
 * Each value is itself LaTeX, expanded in place of the key — `\mathrm{}`
 * renders its argument in upright/roman text instead of the italic
 * KaTeX otherwise uses for a bare undefined-looking identifier, which is
 * the standard convention for a named function/operator (compare built-
 * in `\sin`, `\log`, `\max` — all upright, not italic) and matches how
 * these specific commands render in the tool the formulas were
 * originally authored in.
 *
 * To add another one spotted in a future formula: add a `'\\Name':
 * '\\mathrm{Name}'` entry below (double backslash — this is a JS string,
 * a single `\` alone would be interpreted as a JS escape sequence) and
 * redeploy — every `katex.renderToString` call in the app pulls from
 * this single shared list, in FormulaBlock.tsx.
 */
export const KATEX_MACROS: KatexOptions['macros'] = {
  '\\Buy': '\\mathrm{Buy}',
  '\\Sell': '\\mathrm{Sell}',
  '\\sign': '\\mathrm{sign}',
};
