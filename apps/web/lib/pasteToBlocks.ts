import { randomUUID } from './uuid';
import { sanitizeInlineHtml } from './sanitize';
import type { PageBlock, PageBlockType } from './types';

const BLOCK_LEVEL_TAGS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'HR',
  'TABLE',
]);

export function escapeToHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function newBlock(type: PageBlockType, content: string): PageBlock {
  return { id: randomUUID(), type, content };
}

/** True if `html` has no real block-level structure — just inline text/formatting. */
function isPurelyInline(root: HTMLElement): boolean {
  return !Array.from(root.children).some((el) => BLOCK_LEVEL_TAGS.has(el.tagName));
}

/**
 * Converts pasted HTML (from `clipboardData.getData('text/html')`) into
 * `PageBlock[]`. Handles headings, paragraphs, lists, blockquotes (→
 * callout), code blocks, horizontal rules, and a best-effort flattening of
 * tables (no real table-cell model yet). Inline formatting inside each
 * block goes through the same `sanitizeInlineHtml` allowlist used for
 * normal typing/toolbar formatting.
 *
 * Known limitation: sources that express formatting via inline CSS instead
 * of semantic tags (Google Docs, Word — `<span style="font-weight:700">`
 * rather than `<b>`) will lose that formatting, since the sanitizer strips
 * `style` along with every other attribute. Fine for the common case
 * (copying from web pages, other Notion-like tools, plain rich text) —
 * not a full document-format importer.
 */
export function htmlToBlocks(html: string): PageBlock[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body;

  if (isPurelyInline(root)) {
    const inline = sanitizeInlineHtml(root.innerHTML).trim();
    return inline ? [newBlock('paragraph', inline)] : [];
  }

  const blocks: PageBlock[] = [];

  const addInlineBlock = (type: PageBlockType, el: Element) => {
    const content = sanitizeInlineHtml(el.innerHTML).trim();
    if (content) blocks.push(newBlock(type, content));
  };

  const walkList = (listEl: Element, type: 'bulletList' | 'numberedList') => {
    for (const item of Array.from(listEl.children)) {
      if (item.tagName === 'LI') addInlineBlock(type, item);
    }
  };

  const walk = (container: Element) => {
    for (const child of Array.from(container.children)) {
      switch (child.tagName) {
        case 'H1':
          addInlineBlock('heading1', child);
          break;
        case 'H2':
          addInlineBlock('heading2', child);
          break;
        case 'H3':
        case 'H4':
        case 'H5':
        case 'H6':
          // We only model three heading levels — deeper ones fold into the smallest.
          addInlineBlock('heading3', child);
          break;
        case 'BLOCKQUOTE':
          addInlineBlock('callout', child);
          break;
        case 'PRE':
          blocks.push(newBlock('code', escapeToHtml(child.textContent ?? '')));
          break;
        case 'HR':
          blocks.push(newBlock('divider', ''));
          break;
        case 'UL':
          walkList(child, 'bulletList');
          break;
        case 'OL':
          walkList(child, 'numberedList');
          break;
        case 'TABLE':
          // No real table-cell block yet — flatten rows to "cell | cell" paragraphs
          // rather than silently dropping the data.
          for (const row of Array.from(child.querySelectorAll('tr'))) {
            const cells = Array.from(row.querySelectorAll('td,th'))
              .map((c) => (c.textContent ?? '').trim())
              .join(' | ');
            if (cells.trim()) blocks.push(newBlock('paragraph', escapeToHtml(cells)));
          }
          break;
        case 'P':
        case 'DIV':
          // Some sources (Google Docs, Word) wrap every paragraph in nested
          // DIVs with no direct text — recurse into those; otherwise treat
          // as one inline paragraph.
          if (Array.from(child.children).some((c) => BLOCK_LEVEL_TAGS.has(c.tagName))) {
            walk(child);
          } else {
            addInlineBlock('paragraph', child);
          }
          break;
        default:
          // Unknown wrapper (SPAN, SECTION, etc.) — recurse if it contains
          // block-level children, otherwise treat its content as one paragraph.
          if (child.children.length > 0) {
            walk(child);
          } else {
            addInlineBlock('paragraph', child);
          }
      }
    }
  };

  walk(root);
  return blocks;
}

/**
 * Converts a plain string's inline Markdown (bold/italic/code/strike/link)
 * into the same sanitized inline HTML the live-typing shortcuts and
 * toolbar produce. Unlike the live-typing matcher in Editor.tsx (which
 * only looks at the pattern immediately before the caret while typing,
 * one shortcut at a time), this processes a whole string in one pass —
 * needed when pasting Markdown source text that was never typed
 * character-by-character in this editor at all.
 *
 * Implemented as a single combined regex with ordered alternation rather
 * than several separate global `.replace()` passes: running bold, then
 * italic, then code as *separate* passes risks a later pass matching
 * `*`/`_` characters that an earlier pass already consumed into a `<code>`
 * span's content. A single pass can't do that, because `String.replace`
 * with a global regex scans the original input's positions once — it
 * never re-scans text a prior match in the same call already produced.
 */
export function inlineMarkdownToHtml(rawText: string): string {
  const escaped = escapeToHtml(rawText);
  const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;

  return escaped.replace(pattern, (match, code, linkText, linkHref, bold, strike, italicStar, italicUnderscore) => {
    if (code !== undefined) return `<code>${code}</code>`;
    if (linkText !== undefined) {
      const safeHref = /^(https?:\/\/|\/)/i.test(linkHref) ? linkHref : '#';
      // escapeToHtml above only escapes &/</> — safe for HTML *content*
      // positions, but href="..." is an *attribute* position, which
      // additionally needs quotes escaped. Without this, a link target
      // like `http://x.com" onmouseover="…` closes the attribute early
      // and injects an arbitrary event handler — the leading-scheme
      // check above only validates the prefix, not the rest of the
      // string, so it doesn't catch this on its own.
      return `<a href="${safeHref.replace(/"/g, '&quot;')}">${linkText}</a>`;
    }
    if (bold !== undefined) return `<b>${bold}</b>`;
    if (strike !== undefined) return `<s>${strike}</s>`;
    if (italicStar !== undefined) return `<i>${italicStar}</i>`;
    if (italicUnderscore !== undefined) return `<i>${italicUnderscore}</i>`;
    return match;
  });
}

const HEADING_LINE = /^(#{1,6})\s+(.*)$/;
const TODO_LINE = /^[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET_LINE = /^[-*+]\s+(.*)$/;
const NUMBERED_LINE = /^\d+\.\s+(.*)$/;
const QUOTE_LINE = /^>\s?(.*)$/;
const HR_LINE = /^(-{3,}|\*{3,}|_{3,})$/;
const FENCE_LINE = /^```/;

/**
 * Converts pasted plain-text content — including raw Markdown source, not
 * just literal prose — into blocks. Recognizes the same block-level
 * syntax as the live-typing shortcuts (headings, lists, task lists,
 * blockquotes, fenced code, horizontal rules) plus inline formatting via
 * `inlineMarkdownToHtml`, so pasting Markdown copied from somewhere that
 * doesn't provide an HTML clipboard payload (a "raw" view of a .md file,
 * a plain code viewer, a terminal, etc.) still renders instead of showing
 * literal `#`/`**`/`` ` `` characters. A string with no Markdown syntax at
 * all degrades to exactly what the old line-per-paragraph behavior did.
 */
export function plainTextToBlocks(text: string): PageBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: PageBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      i++;
      continue;
    }

    if (FENCE_LINE.test(line.trim())) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_LINE.test((lines[i] ?? '').trim())) {
        codeLines.push(lines[i] ?? '');
        i++;
      }
      i++; // skip the closing fence, if the text actually had one
      blocks.push(newBlock('code', escapeToHtml(codeLines.join('\n'))));
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    if (HR_LINE.test(line.trim())) {
      blocks.push(newBlock('divider', ''));
      i++;
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading && heading[1] && heading[2] !== undefined) {
      const level = Math.min(heading[1].length, 3);
      const type: PageBlockType = level === 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3';
      blocks.push(newBlock(type, inlineMarkdownToHtml(heading[2])));
      i++;
      continue;
    }

    // Task-list items ("- [ ] text" / "- [x] text") are checked before the
    // plain bullet pattern, which would otherwise also match them and
    // swallow "[ ]"/"[x]" as literal list text instead of a checkbox.
    const todo = TODO_LINE.exec(line);
    if (todo && todo[2] !== undefined) {
      const block = newBlock('todo', inlineMarkdownToHtml(todo[2]));
      block.checked = todo[1]?.toLowerCase() === 'x';
      blocks.push(block);
      i++;
      continue;
    }

    const bullet = BULLET_LINE.exec(line);
    if (bullet && bullet[1] !== undefined) {
      blocks.push(newBlock('bulletList', inlineMarkdownToHtml(bullet[1])));
      i++;
      continue;
    }

    const numbered = NUMBERED_LINE.exec(line);
    if (numbered && numbered[1] !== undefined) {
      blocks.push(newBlock('numberedList', inlineMarkdownToHtml(numbered[1])));
      i++;
      continue;
    }

    const quote = QUOTE_LINE.exec(line);
    if (quote && quote[1] !== undefined) {
      blocks.push(newBlock('callout', inlineMarkdownToHtml(quote[1])));
      i++;
      continue;
    }

    blocks.push(newBlock('paragraph', inlineMarkdownToHtml(line)));
    i++;
  }

  return blocks;
}

/**
 * Renders a chat message's raw Markdown text as HTML — the same inline
 * engine as the editor (`inlineMarkdownToHtml`), plus fenced code blocks
 * (` ``` `), which don't make sense as an *inline* pattern (they're
 * multi-line and their content must stay completely literal, never run
 * through the bold/italic/link patterns). Deliberately does not support
 * block-level Markdown otherwise — headings, lists, blockquotes — since a
 * chat message renders as one bubble of text, not a document; those
 * belong to the article editor, not chat.
 *
 * Splits on fenced blocks first and only feeds the *non-code* segments to
 * `inlineMarkdownToHtml`, so something like `` `*x*` `` inside a code
 * fence is never mistaken for italic — the split guarantees the two
 * passes never see each other's territory.
 */
export function chatMarkdownToHtml(text: string): string {
  const segments = text.split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment) => {
      if (segment.startsWith('```') && segment.endsWith('```')) {
        const code = segment.slice(3, -3).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
        return `<pre><code>${escapeToHtml(code)}</code></pre>`;
      }
      return inlineMarkdownToHtml(segment);
    })
    .join('');
}

/**
 * Converts rich HTML (from the clipboard's `text/html` payload) into
 * Markdown source text — the inverse of `inlineMarkdownToHtml`. Needed
 * specifically for pasting into the chat composer: it's a plain
 * `<textarea>`, which can only ever hold plain text, so pasting real
 * rich-text formatting (bold copied from a webpage, a Word doc, etc.)
 * would otherwise just flatten to unformatted text and lose it entirely.
 * Converting to Markdown *source* first means the formatting survives —
 * it renders back to real formatting when the message displays, via the
 * same `chatMarkdownToHtml` used for hand-typed Markdown.
 *
 * Deliberately narrower than `htmlToBlocks` (the editor's paste
 * converter): no headings/lists/tables — a chat message is one bubble of
 * text, not a document. Block-level tags just contribute a paragraph
 * break, nothing fancier.
 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return htmlNodeToMarkdown(doc.body).trim();
}

function htmlNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  const inner = Array.from(el.childNodes)
    .map(htmlNodeToMarkdown)
    .join('');

  switch (el.tagName) {
    case 'B':
    case 'STRONG':
      return inner.trim() ? `**${inner}**` : inner;
    case 'I':
    case 'EM':
      return inner.trim() ? `*${inner}*` : inner;
    case 'S':
    case 'STRIKE':
    case 'DEL':
      return inner.trim() ? `~~${inner}~~` : inner;
    case 'CODE':
      // A <code> whose parent is <pre> is handled by the PRE case below
      // (via its child's plain-text content) — this branch is only for
      // *inline* code, so it doesn't double-wrap a fenced block's content.
      return el.parentElement?.tagName === 'PRE' ? inner : inner.trim() ? `\`${inner}\`` : inner;
    case 'PRE':
      return `\n\`\`\`\n${el.textContent ?? ''}\n\`\`\`\n`;
    case 'A': {
      const href = el.getAttribute('href');
      return href && inner.trim() ? `[${inner}](${href})` : inner;
    }
    case 'BR':
      return '\n';
    case 'P':
    case 'DIV':
    case 'LI':
      return inner.trim() ? `${inner}\n` : '';
    default:
      return inner;
  }
}
