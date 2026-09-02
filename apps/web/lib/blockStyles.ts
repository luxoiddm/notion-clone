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
};

export const BLOCK_CLASS: Record<PageBlockType, string> = {
  paragraph: 'text-[15px] leading-7',
  heading1: 'text-3xl font-bold leading-tight mt-6',
  heading2: 'text-2xl font-semibold leading-snug mt-5',
  heading3: 'text-xl font-semibold leading-snug mt-4',
  bulletList: 'text-[15px] leading-7',
  numberedList: 'text-[15px] leading-7',
  todo: 'text-[15px] leading-7',
  code: 'font-mono text-sm bg-surface-hover rounded-md p-3 block whitespace-pre-wrap',
  callout: 'text-[15px] leading-7 bg-accent-soft/60 border border-accent/20 rounded-md p-3',
  table: 'text-[15px] leading-7',
  image: '',
  file: '',
  divider: 'border-t border-line/10 my-4',
};
