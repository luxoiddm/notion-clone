import type { PageBlock } from './types';

export interface HeadingEntry {
  blockId: string;
  level: 1 | 2 | 3;
  text: string;
}

const LEVEL_BY_TYPE: Partial<Record<PageBlock['type'], 1 | 2 | 3>> = {
  heading1: 1,
  heading2: 2,
  heading3: 3,
};

/**
 * Strips tags for a plain-text label — a heading's content can carry
 * inline formatting (bold, links, ...), none of which belongs in a
 * compact sidebar list entry. Regex, not a DOM element: this runs inside
 * a `useMemo` during render, not from a discrete user-interaction
 * handler — `document` isn't guaranteed to exist there the way it is in
 * an onClick/onPaste callback (e.g. if this route is ever server-
 * rendered), so building a real DOM node here would be a latent SSR crash.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function extractHeadings(blocks: PageBlock[]): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  for (const block of blocks) {
    const level = LEVEL_BY_TYPE[block.type];
    if (!level) continue;
    const text = stripHtml(block.content);
    if (!text) continue; // an empty heading being typed isn't a section yet
    headings.push({ blockId: block.id, level, text });
  }
  return headings;
}
