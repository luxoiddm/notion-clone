import type { PageBlockType } from './types';

export const BLOCK_TAG: Record<PageBlockType, string> = {
  paragraph: 'p',
  heading1: 'h1',
  heading2: 'h2',
  heading3: 'h3',
  bulletList: 'li',
  numberedList: 'li',
  todo: 'p',
  code: 'code',
  callout: 'p',
  table: 'p',
  image: 'p',
  file: 'p',
  divider: 'div',
  // Not a contentEditable text tag like every other type here — the
  // formula block has its own dedicated edit/view component
  // (FormulaBlockContent in FormulaBlock.tsx), same reasoning as
  // image/file above. 'div' is just what BlockRow's read-only preview
  // and PageHistoryDialog's BlockPreview fall back to for layout.
  formula: 'div',
};

export const BLOCK_CLASS: Record<PageBlockType, string> = {
  paragraph: 'text-[16px] leading-[1.75]',
  heading1: 'text-[30px] font-semibold tracking-[-0.02em] leading-tight',
  heading2: 'text-[23px] font-semibold tracking-[-0.015em] leading-snug',
  heading3: 'text-[18px] font-semibold tracking-[-0.01em] leading-snug',
  bulletList: 'text-[16px] leading-[1.75]',
  numberedList: 'text-[16px] leading-[1.75]',
  todo: 'text-[16px] leading-[1.75]',
  code: 'font-mono text-[13px] leading-6 bg-surface-sunken border border-line/[0.06] rounded-lg px-4 py-3 my-1 block whitespace-pre-wrap',
  callout: 'text-[15px] leading-7 bg-accent-soft/50 border border-accent/15 rounded-lg px-4 py-3 my-1',
  table: 'text-[15px] leading-7',
  image: '',
  file: '',
  divider: 'border-t border-line/[0.1] my-6',
  formula: '',
};

/**
 * Отступ сверху для заголовков — вынесен из BLOCK_CLASS на уровень строки
 * блока, чтобы кнопки «+»/перетаскивание в редакторе выравнивались по
 * самому тексту заголовка, а не по верхнему краю его margin.
 */
export const BLOCK_SPACING: Partial<Record<PageBlockType, string>> = {
  heading1: 'mt-8',
  heading2: 'mt-6',
  heading3: 'mt-4',
};
