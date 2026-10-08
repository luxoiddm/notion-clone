'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BLOCK_TAG, BLOCK_CLASS, BLOCK_SPACING } from '../lib/blockStyles';
import {
  GripVertical,
  Plus,
  Bold,
  Italic,
  Strikethrough,
  Code2,
  Link as LinkIcon,
  FileText,
  Eye,
  Image as ImageIcon,
  ImagePlus,
  Paperclip,
  Loader2,
  Trash2,
  ChevronDown,
  FileSymlink,
  SquareCode,
  RemoveFormatting,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import type { PageBlock, PageBlockType } from '../lib/types';
import { randomUUID } from '../lib/uuid';
import { withAuthToken, filesApi, type UserFileInfo } from '../lib/api';
import { FilePreviewDialog } from './FilePreviewDialog';
import { sanitizeInlineHtml } from '../lib/sanitize';
import { PageIconPicker } from './PageIconPicker';
import { PageCoverPicker } from './PageCoverPicker';
import { useTheme } from 'next-themes';
import { isCoverColor, resolveCoverColorHex, textColorForCover } from '../lib/coverColors';
import { htmlToBlocks, plainTextToBlocks, escapeToHtml } from '../lib/pasteToBlocks';
import { FormulaBlockContent, hydrateInlineFormulas } from './FormulaBlock';
import { editorWidthStyle } from '../lib/editorWidth';
import { useToast } from './Toast';
import { SlashMenu, SLASH_OPTIONS, filterSlashOptions } from './SlashMenu';
import { FilePickerDialog } from './FilePickerDialog';
import { PagePickerDialog, type AttachedPageRef } from './PagePickerDialog';
import { PageBlockPickerDialog } from './PageBlockPickerDialog';

interface EditorProps {
  title: string;
  onTitleChange: (title: string) => void;
  icon: string | null;
  onIconChange: (icon: string | null) => void;
  cover: string | null;
  onCoverChange: (cover: string | null) => void;
  /** Reuses the existing page-asset upload mechanism (same one image/file blocks already use) — returns the uploaded image's URL, which the caller then passes to onCoverChange itself. Kept as a separate step (upload, then set) rather than one combined call, matching how block-level image uploads already work in this file. */
  uploadCoverImage: (file: File) => Promise<string>;
  blocks: PageBlock[];
  onBlocksChange: (updater: PageBlock[] | ((prev: PageBlock[]) => PageBlock[])) => void;
  readOnly?: boolean;
  currentUserId: string;
  /** Called when a page-reference link (inserted via the "attach document" toolbar button) is opened — Ctrl/Cmd+click, matching how a regular link already opens. `blockId`, when present, means the link targets a specific block within that page rather than the page as a whole — see `insertPageRefLink`'s own doc comment. */
  onOpenPageRef: (ownerId: string, projectId: string, pageId: string, blockId?: string) => void;
  /** Set by the parent right after `onOpenPageRef` navigates somewhere with a target block — this component scrolls to and briefly highlights that block once it actually appears in `blocks` (which may be a render or two after navigation starts, while the target page's content is still loading). `onScrolledToBlock` clears it back to null in the parent once handled, so a later click on the *same* block-linking anchor can trigger the scroll again. */
  scrollToBlockId?: string | null;
  onScrolledToBlock?: () => void;
}

// Block types that need a file (picked from personal storage or uploaded
// fresh) rather than typed text — selecting them from the slash menu opens
// the file picker instead of turning into an editable block directly.
const FILE_BACKED_TYPES = new Set<PageBlockType>(['image', 'file']);

// Custom dataTransfer MIME type used to distinguish "dragging one of our
// own blocks to reorder it" from an OS file drag or the browser's native
// text-selection drag — all three can be in flight over the same block.
const BLOCK_DRAG_MIME = 'application/x-notion-clone-block-id';

/**
 * Matches Markdown shortcuts typed at the start of an empty paragraph —
 * "# ", "- ", "1. ", etc. — converting the block instead of leaving the
 * literal characters. Checked against the block's full current text on
 * every keystroke (see handleInput), so these only fire the instant the
 * pattern is complete (e.g. right after the space following "#").
 */
function matchBlockMarkdown(text: string): PageBlockType | null {
  if (text === '# ') return 'heading1';
  if (text === '## ') return 'heading2';
  if (text === '### ') return 'heading3';
  if (text === '- ' || text === '* ') return 'bulletList';
  if (/^\d+\.\s$/.test(text)) return 'numberedList';
  if (text === '[] ' || text === '[ ] ') return 'todo';
  if (text === '> ') return 'callout';
  if (text === '```') return 'code';
  if (text === '---') return 'divider';
  if (text === '$$') return 'formula';
  return null;
}
// INLINE_MARKDOWN_INSERT_POINT

interface InlineMarkdownMatch {
  start: number;
  end: number;
  innerText: string;
  tag: 'b' | 'i' | 'code' | 's' | 'a';
  href?: string;
}

/**
 * Matches an inline Markdown pattern ending exactly at the cursor —
 * bold/italic/code/strikethrough/link. Only looks at text immediately
 * before the cursor (not the whole block), so it fires the instant a
 * pattern is completed by the character just typed, the same way
 * block-level shortcuts do. Order matters: bold is checked before
 * single-star italic, and the italic check requires the opening star not
 * be preceded by another star, so a completed bold pattern never also
 * reads as italic on top.
 *
 * The underscore-italic check additionally requires a non-word character
 * (or start of block) before the opening `_` and — via `charAfterCaret`,
 * since text after the cursor isn't part of `textBeforeCursor` at all —
 * a non-word character (or end of block) right after the closing `_`.
 * Matches CommonMark's own rule that `_..._`, unlike `*...*`, doesn't
 * work *inside* a word: without this, typing a plain variable name like
 * `v_in_left` (no backslash, ordinary prose, not even LaTeX) would
 * misfire into `v<i>in</i>left` the instant the second underscore was
 * typed, well before the rest of the word existed to reveal that this
 * was never meant as emphasis. `pasteToBlocks.ts`'s `inlineMarkdownToHtml`
 * applies the same rule for pasted text — see its own doc comment for the
 * full reasoning (there also covering `\_`-escaped LaTeX specifically).
 */
function matchInlineMarkdown(textBeforeCursor: string, charAfterCursor: string): InlineMarkdownMatch | null {
  let m: RegExpExecArray | null;

  m = /\*\*([^*\n]+)\*\*$/.exec(textBeforeCursor);
  if (m && m[1]) return { start: m.index, end: textBeforeCursor.length, innerText: m[1], tag: 'b' };

  m = /~~([^~\n]+)~~$/.exec(textBeforeCursor);
  if (m && m[1]) return { start: m.index, end: textBeforeCursor.length, innerText: m[1], tag: 's' };

  m = /`([^`\n]+)`$/.exec(textBeforeCursor);
  if (m && m[1]) return { start: m.index, end: textBeforeCursor.length, innerText: m[1], tag: 'code' };

  m = /\[([^\]\n]+)\]\(([^)\n]+)\)$/.exec(textBeforeCursor);
  if (m && m[1] && m[2]) return { start: m.index, end: textBeforeCursor.length, innerText: m[1], tag: 'a', href: m[2] };

  m = /(?<!\*)\*([^*\n]+)\*$/.exec(textBeforeCursor);
  if (m && m[1]) return { start: m.index, end: textBeforeCursor.length, innerText: m[1], tag: 'i' };

  m = /(?<!_)(?<!\w)_([^_\n]+)_$/.exec(textBeforeCursor);
  if (m && m[1] && !/\w/.test(charAfterCursor)) return { start: m.index, end: textBeforeCursor.length, innerText: m[1], tag: 'i' };

  return null;
}

/** Plain-text [start, end) offset pair of `range`, measured from the start of `root`'s text content — generalizes `getCaretOffsetWithin` below to a non-collapsed range too. */
function getRangeOffsetsWithin(root: HTMLElement, range: Range): { start: number; end: number } {
  const startRange = range.cloneRange();
  startRange.selectNodeContents(root);
  startRange.setEnd(range.startContainer, range.startOffset);
  const endRange = range.cloneRange();
  endRange.selectNodeContents(root);
  endRange.setEnd(range.endContainer, range.endOffset);
  return { start: startRange.toString().length, end: endRange.toString().length };
}

/** Plain-text offset of the current caret, measured from the start of `root`'s text content. */
function getCaretOffsetWithin(root: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;
  return getRangeOffsetsWithin(root, selection.getRangeAt(0)).end;
}

/** Converts a plain-text [start, end) offset pair (relative to `root`) into a DOM Range, walking text nodes to find the right spots. */
function createRangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Node | null = null;
  let startOffset = 0;
  let endNode: Node | null = null;
  let endOffset = 0;

  let node = walker.nextNode();
  while (node) {
    const len = node.textContent ? node.textContent.length : 0;
    if (startNode === null && pos + len >= start) {
      startNode = node;
      startOffset = start - pos;
    }
    if (endNode === null && pos + len >= end) {
      endNode = node;
      endOffset = end - pos;
      break;
    }
    pos += len;
    node = walker.nextNode();
  }
  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/**
 * Checks whether the caret just completed an inline Markdown pattern and,
 * if so, replaces the raw markup with the real inline element directly in
 * the DOM (delete the matched range, insert the tag, move the caret after
 * it) — mirrors how the toolbar's execCommand-based formatting mutates
 * the DOM directly rather than going through React state first. Returns
 * true if a conversion happened, so the caller can derive content from
 * the post-conversion DOM instead of the pre-conversion one.
 */
function tryConvertInlineMarkdown(el: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;

  const caretOffset = getCaretOffsetWithin(el);
  const fullText = el.textContent ?? '';
  const textBeforeCaret = fullText.slice(0, caretOffset);
  const charAfterCaret = fullText[caretOffset] ?? '';
  const match = matchInlineMarkdown(textBeforeCaret, charAfterCaret);
  if (!match) return false;

  const range = createRangeFromOffsets(el, match.start, match.end);
  if (!range) return false;

  range.deleteContents();
  const tag = document.createElement(match.tag);
  tag.textContent = match.innerText;
  if (match.tag === 'a') tag.setAttribute('href', match.href ?? '#');
  range.insertNode(tag);

  // Places the caret in the tag's *parent*, right after the tag itself
  // — a collapsed Range/Selection can sit between two child nodes of an
  // element just as well as inside a text node, and typing at that
  // position makes the browser insert a fresh plain text node there on
  // its own. No placeholder character needed for this, unlike an
  // earlier version of this function which inserted a zero-width space
  // (`\u200B`) as a landing spot instead: that character became a
  // permanent, invisible pollutant of the *stored* content — it doesn't
  // get cleaned up even if the surrounding formatting is later removed
  // via the toolbar, since toggling `<i>`/`<b>` off doesn't touch a
  // separate sibling text node — silently breaking substring search on
  // any word it ended up inside (e.g. "разреш\u200Bенная" no longer
  // matching a search for "разрешенная"). sanitizeInlineHtml() (see
  // sanitize.ts) additionally strips any stray zero-width space it
  // finds, so a block already carrying one from before this fix heals
  // itself the next time that block is edited and saved.
  const parent = tag.parentNode;
  if (parent) {
    const indexAfterTag = Array.prototype.indexOf.call(parent.childNodes, tag) + 1;
    const newRange = document.createRange();
    newRange.setStart(parent, indexAfterTag);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
  }

  return true;
}

/**
 * Converts a range of blocks into HTML for the clipboard when copying a
 * multi-block selection — grouping consecutive list-item blocks into a
 * single `<ul>`/`<ol>` (each block only holds one `<li>` worth of content)
 * so both external apps and, when pasted back in, our own
 * `htmlToBlocks()` paste-parser reconstruct the list structure correctly
 * instead of one `<ul>` per item.
 */
function blocksToClipboardHtml(list: PageBlock[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < list.length) {
    const block = list[i];
    if (!block) {
      i++;
      continue;
    }

    if (block.type === 'bulletList' || block.type === 'numberedList') {
      const tag = block.type === 'bulletList' ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < list.length) {
        const current = list[i];
        if (!current || current.type !== block.type) break;
        items.push(`<li>${current.content}</li>`);
        i++;
      }
      parts.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    parts.push(blockToClipboardHtmlSingle(block));
    i++;
  }
  return parts.join('');
}

/**
 * Same per-block mapping as blocksToClipboardHtml (reuses
 * blockToClipboardHtmlSingle directly) — but one line per block, and one
 * line per `<li>` within a list, for a human reading/editing the source-
 * view textarea. blocksToClipboardHtml itself stays compact and
 * unbroken on purpose: that one feeds the clipboard, read by another
 * app's paste handler, not by a person, so added whitespace there would
 * be pure overhead. Safe to add newlines here without them turning into
 * spurious blocks on the way back through htmlToBlocks() — that parser
 * walks `.children` (elements only), never looks at whitespace-only
 * text nodes between tags at all.
 */
function blocksToFormattedSourceHtml(list: PageBlock[]): string {
  const lines: string[] = [];
  let i = 0;
  while (i < list.length) {
    const block = list[i];
    if (!block) {
      i++;
      continue;
    }

    if (block.type === 'bulletList' || block.type === 'numberedList') {
      const tag = block.type === 'bulletList' ? 'ul' : 'ol';
      lines.push(`<${tag}>`);
      while (i < list.length) {
        const current = list[i];
        if (!current || current.type !== block.type) break;
        lines.push(`  <li>${current.content}</li>`);
        i++;
      }
      lines.push(`</${tag}>`);
      continue;
    }

    lines.push(blockToClipboardHtmlSingle(block));
    i++;
  }
  return lines.join('\n');
}

function blockToClipboardHtmlSingle(block: PageBlock): string {
  switch (block.type) {
    case 'heading1':
      return `<h1>${block.content}</h1>`;
    case 'heading2':
      return `<h2>${block.content}</h2>`;
    case 'heading3':
      return `<h3>${block.content}</h3>`;
    case 'callout':
      return `<blockquote>${block.content}</blockquote>`;
    case 'code':
      return `<pre>${block.content}</pre>`;
    case 'formula':
      // block.content is a raw LaTeX string, not HTML (unlike every
      // other case here) — must be escaped before going into markup,
      // same reasoning as escapeToHtml's own doc comment in
      // pasteToBlocks.ts.
      return `<pre>${escapeToHtml(block.content)}</pre>`;
    case 'divider':
      return '<hr>';
    case 'todo':
      return `<p>${block.checked ? '\u2611' : '\u2610'} ${block.content}</p>`;
    case 'image':
      return `<p><img src="${block.content}" alt="${block.fileName ?? ''}"></p>`;
    case 'file':
      return `<p><a href="${block.content}">${block.fileName ?? 'Файл'}</a></p>`;
    default:
      return `<p>${block.content}</p>`;
  }
}

/** Plain-text fallback for a single block, used for the clipboard's text/plain entry. */
function blockToPlainText(block: PageBlock): string {
  if (block.type === 'divider') return '---';
  if (block.type === 'image' || block.type === 'file') return block.fileName ?? block.content;
  // content is already plain LaTeX text, not HTML — running it through
  // the innerHTML→textContent round-trip below (like every other block
  // type) would misinterpret any literal '<'/'>'/'&' in the formula as
  // markup instead of taking it as-is.
  if (block.type === 'formula') return block.content;
  const div = document.createElement('div');
  div.innerHTML = block.content;
  const text = div.textContent ?? '';
  return block.type === 'todo' ? `${block.checked ? '[x]' : '[ ]'} ${text}` : text;
}


export function Editor({
  title,
  onTitleChange,
  icon,
  onIconChange,
  cover,
  onCoverChange,
  uploadCoverImage,
  blocks,
  onBlocksChange,
  readOnly = false,
  currentUserId,
  onOpenPageRef,
  scrollToBlockId,
  onScrolledToBlock,
}: EditorProps) {
  const [slashState, setSlashState] = useState<{ blockId: string; query: string; position: { top: number; left: number } } | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [dragOverAssets, setDragOverAssets] = useState(false);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  /**
   * Briefly highlights a block after navigating to it via a page-
   * reference link that targets a specific block (see the effect below
   * and `insertPageRefLink`'s own doc comment) — separate from
   * `scrollToBlockId` itself (a prop, owned by the parent) because the
   * highlight needs to fade back to nothing a couple seconds later
   * regardless of what the parent does with its own state afterward.
   */
  const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null);

  // Scrolls to and briefly highlights the block a page-reference link
  // pointed at, once it actually exists in `blocks` — which, for a link
  // that navigated to a *different* page, may not be true on the very
  // render this effect first sees `scrollToBlockId` change, since that
  // page's own content is still loading at that point. Re-running on
  // every `blocks` change (not just `scrollToBlockId`) is what lets it
  // wait out that load rather than firing once, finding nothing, and
  // giving up — the effect keeps re-checking as new block data arrives
  // until it finds the target or `scrollToBlockId` is cleared.
  useEffect(() => {
    if (!scrollToBlockId) return;
    if (!blocks.some((b) => b.id === scrollToBlockId)) return; // not loaded yet — wait for the next `blocks` update
    const el = document.querySelector<HTMLElement>(`[data-block-row-id="${scrollToBlockId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedBlockId(scrollToBlockId);
    onScrolledToBlock?.();
    const timeout = setTimeout(() => setHighlightedBlockId(null), 2000);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToBlockId, blocks]);

  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const coverButtonRef = useRef<HTMLButtonElement>(null);
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';
  const coverTextColor: 'white' | 'dark' = cover && isCoverColor(cover) ? textColorForCover(resolveCoverColorHex(cover, isDarkTheme)) : 'white';
  /**
   * Whole-document raw-HTML source view — like GitLab's "view source"
   * toggle for a file, not scoped to a single block. `sourceText` is a
   * local draft, independent of `blocks` while active (so typing doesn't
   * re-parse on every keystroke); it's only converted back into blocks
   * when leaving the view. Serialization reuses blocksToClipboardHtml()
   * (the same function that already builds real block-level HTML — h1,
   * ul/li grouping, etc. — for copying a selection to the clipboard);
   * deserialization reuses htmlToBlocks(), the existing paste parser —
   * neither needed reimplementing for this.
   */
  const [isSourceView, setIsSourceView] = useState(false);
  const [sourceText, setSourceText] = useState('');

  const [filePickerState, setFilePickerState] = useState<{ blockId: string; kind: 'image' | 'file' } | null>(null);
  /**
   * Drives the two-step "link to a document" flow (see `insertPageRefLink`
   * below for the full picture). `selection` is captured at the moment
   * the toolbar button is clicked — a `{start, end}` plain-text offset
   * pair (see `getRangeOffsetsWithin`) rather than the live browser
   * `Selection`/`Range` itself, because opening `PagePickerDialog` moves
   * focus away from the contentEditable block and would otherwise
   * collapse or lose it entirely before the user finishes picking a
   * target. `null` means there was no non-empty selection when the
   * button was clicked — the existing "insert a 📄 Title chip" behavior,
   * unchanged from before this two-step flow existed. `targetPage` is
   * set once `PagePickerDialog` (step 1) resolves, at which point
   * `PageBlockPickerDialog` (step 2) takes over; both dialogs read from
   * and clear this same state object rather than each owning separate
   * state, so there's exactly one place tracking "is this flow active
   * and how far along is it".
   */
  const [pageRefFlow, setPageRefFlow] = useState<{
    blockId: string;
    selection: { start: number; end: number } | null;
    targetPage: AttachedPageRef | null;
  } | null>(null);
  // Tracks in-flight clipboard-image uploads as a purely local UI concern,
  // deliberately kept OUT of `blocks` — that array is the persisted model
  // (autosaved 3s after every change), and a "Загрузка..." placeholder has
  // no business ever being written to disk if the debounce fires mid-upload.
  const [pendingUploads, setPendingUploads] = useState<{ id: string; anchorId: string }[]>([]);
  // Block reordering (grip-handle drag): which block is being dragged, and
  // which block/edge it's currently hovering over — drives the drop
  // indicator line. Separate from `dragOverAssets` below, which is for
  // dragging an OS file in to upload, not reordering existing blocks.
  const [dropTarget, setDropTarget] = useState<{ blockId: string; position: 'before' | 'after' } | null>(null);
  // Block-range selection (Asana/Notion-style): the browser can't natively
  // select text across two separate contentEditable blocks, so dragging
  // the mouse from one block into another is detected here and switches
  // into a distinct "these whole blocks are selected" mode instead —
  // rendered as a highlight, not a native text selection. `startId`/
  // `endId` are block ids; which one is visually first is resolved from
  // the current `blocks` order when computing the highlighted set, not
  // baked into the state itself.
  const [blockSelection, setBlockSelection] = useState<{ startId: string; endId: string } | null>(null);
  const dragAnchorId = useRef<string | null>(null);
  const isBlockDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { push } = useToast();

  // Tracks a mouse drag that starts in one block's content and moves into
  // another — the trigger for switching into block-range selection. Uses
  // document-level listeners (not per-block handlers) since we need to
  // know which block the pointer is over regardless of which element
  // originally received the mousedown; the handler no-ops instantly
  // whenever `dragAnchorId.current` is null (not currently dragging), so
  // the constant listener has negligible cost outside an active drag.
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragAnchorId.current) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const rowEl = target?.closest('[data-block-row-id]');
      const overId = rowEl?.getAttribute('data-block-row-id');
      if (!overId) return;

      if (overId !== dragAnchorId.current || isBlockDragging.current) {
        if (!isBlockDragging.current) {
          // Just crossed into a different block for the first time this
          // drag — native text selection can't span this, so drop
          // whatever partial selection the browser already started.
          isBlockDragging.current = true;
          window.getSelection()?.removeAllRanges();
        }
        setBlockSelection({ startId: dragAnchorId.current, endId: overId });
      }
    };

    const handleMouseUp = () => {
      dragAnchorId.current = null;
      isBlockDragging.current = false;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Starts (or extends, with Shift) a block-range selection. A plain
  // click always clears any existing range first — the drag-tracking
  // effect above re-establishes one only if the mouse actually moves into
  // a different block before release, so an ordinary single click inside
  // a block just clears the highlight and edits normally.
  const handleContentMouseDown = (e: React.MouseEvent, blockId: string) => {
    if (e.button !== 0) return;
    if (e.shiftKey && focusedBlockId) {
      e.preventDefault();
      setBlockSelection({ startId: focusedBlockId, endId: blockId });
      return;
    }
    setBlockSelection(null);
    dragAnchorId.current = blockId;
    isBlockDragging.current = false;
  };

  // Resolves the range into the actual set of selected block ids, using
  // the blocks' current order — `blockSelection.startId`/`endId` don't
  // encode which one comes first visually.
  const selectedBlockIds = (() => {
    if (!blockSelection) return null;
    const startIdx = blocks.findIndex((b) => b.id === blockSelection.startId);
    const endIdx = blocks.findIndex((b) => b.id === blockSelection.endId);
    if (startIdx === -1 || endIdx === -1) return null;
    const [from, to] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
    return new Set(blocks.slice(from, to + 1).map((b) => b.id));
  })();

  const deleteSelectedBlocks = () => {
    if (!selectedBlockIds) return;
    onBlocksChange((prev) => {
      const remaining = prev.filter((b) => !selectedBlockIds.has(b.id));
      // Never delete down to zero blocks — same guard as the single-block delete button.
      return remaining.length > 0 ? remaining : prev;
    });
    setBlockSelection(null);
  };

  const copySelectedBlocks = async () => {
    if (!selectedBlockIds) return;
    const selected = blocks.filter((b) => selectedBlockIds.has(b.id));
    const html = blocksToClipboardHtml(selected);
    const text = selected.map(blockToPlainText).join('\n');
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
    } catch {
      // Clipboard API can fail (permissions, insecure context, older
      // browser without ClipboardItem) — plain text is better than nothing.
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Truly nothing we can do here — no dialog, this runs from a
        // keyboard shortcut and shouldn't interrupt typing with a prompt.
      }
    }
  };

  // Delete/Backspace/Ctrl+C/Ctrl+X act on the whole range at once while a
  // block selection is active. Escape clears it, same as the slash menu
  // and other transient UI in this editor.
  useEffect(() => {
    if (!blockSelection) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setBlockSelection(null);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelectedBlocks();
        return;
      }
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void copySelectedBlocks();
        return;
      }
      if (meta && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        void copySelectedBlocks();
        deleteSelectedBlocks();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockSelection, selectedBlockIds, blocks]);

  // Two-stage Ctrl+A, like Google Docs: a contentEditable already selects
  // all text *within itself* on the first Ctrl+A natively, for free — we
  // only need to detect that a block's text is already fully selected and
  // upgrade to a full-document block-range selection on the next press.
  useEffect(() => {
    const handleSelectAll = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;

      const activeEl = document.activeElement;
      if (!activeEl) return;
      const blockId = activeEl.getAttribute('data-block-id');
      if (!blockId) return; // focus isn't in one of our blocks — leave native Ctrl+A alone (e.g. the title field)

      const selection = window.getSelection();
      const totalLength = activeEl.textContent?.length ?? 0;
      const alreadyFullySelected =
        !!selection && selection.rangeCount > 0 && !selection.isCollapsed && totalLength > 0 && selection.toString().length >= totalLength;

      if (alreadyFullySelected) {
        e.preventDefault();
        const first = blocks[0];
        const last = blocks[blocks.length - 1];
        if (first && last) setBlockSelection({ startId: first.id, endId: last.id });
      } else if (blockSelection) {
        // Falling through to a native single-block select-all while a
        // range was active — clear it so we don't end up with both a
        // native text selection and a block highlight at once.
        setBlockSelection(null);
      }
    };
    document.addEventListener('keydown', handleSelectAll);
    return () => document.removeEventListener('keydown', handleSelectAll);
  }, [blocks, blockSelection]);

  const updateBlock = useCallback(
    (id: string, patch: Partial<PageBlock>) => {
      onBlocksChange((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    },
    [onBlocksChange],
  );

  const insertBlockAfter = useCallback(
    (afterId: string, type: PageBlockType = 'paragraph') => {
      const newBlock: PageBlock = { id: randomUUID(), type, content: '' };
      onBlocksChange((prev) => {
        const idx = prev.findIndex((b) => b.id === afterId);
        const next = [...prev];
        next.splice(idx + 1, 0, newBlock);
        return next;
      });
      requestAnimationFrame(() => focusBlock(newBlock.id));
    },
    [onBlocksChange],
  );

  const removeBlock = useCallback(
    (id: string) => {
      onBlocksChange((prev) => (prev.length > 1 ? prev.filter((b) => b.id !== id) : prev));
    },
    [onBlocksChange],
  );

  const focusBlock = (id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
    el?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>, block: PageBlock) => {
    if (slashState?.blockId === block.id) {
      const filtered = filterSlashOptions(slashState.query);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveSlashIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Escape') {
        setSlashState(null);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const chosen = filtered[activeSlashIndex] ?? filtered[0];
        if (chosen) pickSlashType(chosen.type);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const isListType = block.type === 'bulletList' || block.type === 'numberedList' || block.type === 'todo';
      if (isListType && block.content === '') {
        // Enter on an empty list item exits list mode instead of adding
        // yet another empty item — the standard convention (Notion and
        // most block editors behave the same way).
        convertBlockType(block.id, 'paragraph');
      } else if (isListType) {
        // Continues the same block type — a checklist item, bulleted
        // item, or numbered item all beget another one of their own
        // kind, not a plain paragraph. Numbering itself isn't stored per
        // block; it's computed at render time from position among
        // consecutive numberedList blocks (see the `blocks.map` loop),
        // so there's nothing to increment here explicitly — the next
        // block just needs to *be* a numberedList block, the number
        // follows automatically.
        insertBlockAfter(block.id, block.type);
      } else {
        insertBlockAfter(block.id);
      }
      setSlashState(null);
      return;
    }

    if (e.key === 'Backspace' && block.content === '') {
      e.preventDefault();
      const idx = blocks.findIndex((b) => b.id === block.id);
      const previous = idx > 0 ? blocks[idx - 1] : undefined;
      removeBlock(block.id);
      if (previous) requestAnimationFrame(() => focusBlock(previous.id));
    }
  };

  const handleInput = (e: React.FormEvent<HTMLElement>, block: PageBlock) => {
    const el = e.currentTarget;
    if (blockSelection) setBlockSelection(null);

    // Inline Markdown (**bold**, *italic*, `code`, [text](url)...) mutates
    // the DOM directly, the same way the toolbar's execCommand-based
    // formatting does — never inside a code block, where the raw
    // characters are meant to stay literal.
    const convertedInline = block.type !== 'code' && tryConvertInlineMarkdown(el);

    const text = el.textContent ?? '';
    const html = sanitizeInlineHtml(el.innerHTML);
    updateBlock(block.id, { content: html });

    if (convertedInline) return; // inline conversion already handled this keystroke

    if (text.startsWith('/')) {
      const rect = el.getBoundingClientRect();
      setSlashState({ blockId: block.id, query: text.slice(1), position: { top: rect.bottom + 4, left: rect.left } });
      setActiveSlashIndex(0);
      return;
    }
    if (slashState?.blockId === block.id) {
      setSlashState(null);
    }

    // Markdown shortcuts only apply to plain paragraphs being typed from
    // scratch — never inside a code block (where "# " should stay literal
    // text) or any other already-converted block type.
    if (block.type === 'paragraph') {
      const markdownType = matchBlockMarkdown(text);
      if (markdownType) convertBlockType(block.id, markdownType, { clearContent: true });
    }
  };

  // Page-reference links (inserted via the "attach document" toolbar
  // button) always need interception, in *both* edit and read-only
  // rendering, regardless of Ctrl/Cmd — their href
  // (/page-ref/{ownerId}/{projectId}/{pageId}, optionally with a
  // trailing /{blockId} when the link targets a specific block within
  // that page) isn't a real route anything serves, so unlike a genuine
  // URL there's no "just let the browser handle it" fallback to lean
  // on; native navigation there would just 404. A genuine external/internal link is different: in
  // read-only rendering (contentEditable off) native <a> click already
  // works correctly, nothing to do here — in edit mode, only
  // Ctrl/Cmd+click should navigate, since a plain click needs to place
  // the cursor instead (browsers already suppress plain-click
  // navigation inside contentEditable regardless, this just makes it
  // explicit and cross-browser-consistent).
  const handleLinkClick = (e: React.MouseEvent<HTMLElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;

    const href = anchor.getAttribute('href') ?? '#';
    const pageRefMatch = href.match(/^\/page-ref\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
    if (pageRefMatch) {
      e.preventDefault();
      const [, ownerId, projectId, pageId, blockId] = pageRefMatch;
      if (ownerId && projectId && pageId) onOpenPageRef(ownerId, projectId, pageId, blockId);
      return;
    }

    if (readOnly) return;
    e.preventDefault();
    if (!(e.ctrlKey || e.metaKey)) return;
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  // Uploads one file to the user's personal file storage and inserts a
  // block for it right after `anchorId` (image block if the file is an
  // image, generic file block otherwise) — the single shared upload path
  // for both clipboard-image paste and drag-and-drop below. Shows a
  // "Загрузка..." placeholder for the duration (see `pendingUploads`
  // above) and reports failures via toast without losing the rest of a
  // multi-file batch. Returns the new block's id so callers processing
  // several files in sequence can anchor the next one after this one,
  // keeping insertion order correct; falls back to the original anchor on
  // failure so a subsequent file in the same batch still has somewhere
  // valid to insert after.
  const uploadFileAndInsertBlock = async (file: File, anchorId: string): Promise<string> => {
    const pendingId = randomUUID();
    setPendingUploads((prev) => [...prev, { id: pendingId, anchorId }]);
    try {
      const info = await filesApi.upload(file);
      const newBlockId = randomUUID();
      const isImage = info.mimeType.startsWith('image/');
      onBlocksChange((prev) => {
        const idx = prev.findIndex((b) => b.id === anchorId);
        const next = [...prev];
        next.splice(idx === -1 ? next.length : idx + 1, 0, {
          id: newBlockId,
          type: isImage ? 'image' : 'file',
          content: info.url,
          fileName: info.originalName,
        });
        return next;
      });
      return newBlockId;
    } catch (err) {
      push(err instanceof Error ? err.message : 'Не удалось загрузить файл', 'error');
      return anchorId;
    } finally {
      setPendingUploads((prev) => prev.filter((p) => p.id !== pendingId));
    }
  };

  // Uploads image(s) found directly in the clipboard (screenshots, "copy
  // image" from elsewhere), inserting each as a real image block once its
  // upload finishes. Processed one at a time (not in parallel) so that
  // pasting several images at once keeps them in the order they were
  // pasted, each new block anchored after the previous one rather than
  // all racing to insert after the same spot.
  const uploadClipboardImages = async (files: File[], startAnchorId: string) => {
    let anchorId = startAnchorId;
    for (const file of files) {
      anchorId = await uploadFileAndInsertBlock(file, anchorId);
    }
  };

  // Converts pasted content into blocks instead of letting the browser
  // dump raw/foreign HTML into the DOM. Plain single-line/inline pastes go
  // in at the cursor (so pasting a word mid-sentence works normally);
  // anything with real block structure (headings, lists, quotes...)
  // becomes proper blocks, replacing the current one if it was empty or
  // inserted after it otherwise.
  const handlePaste = (e: React.ClipboardEvent<HTMLElement>, block: PageBlock) => {
    // An actual image in the clipboard (not just an <img> tag referencing
    // some external URL inside pasted HTML) always wins: the requirement
    // is that pasted images land in the user's own storage, not that we
    // link out to wherever they were copied from. Some sources (e.g.
    // "copy image" in a browser) populate both an image file AND
    // text/html with an external <img src>; we deliberately only handle
    // the file in that case and skip the accompanying html for this paste.
    const imageFiles = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);

    if (imageFiles.length > 0) {
      e.preventDefault();
      void uploadClipboardImages(imageFiles, block.id);
      return;
    }

    const html = e.clipboardData.getData('text/html');
    const plain = e.clipboardData.getData('text/plain');
    if (!html && !plain) return;

    e.preventDefault();
    const pasted = html ? htmlToBlocks(html) : plainTextToBlocks(plain);
    const [firstPasted] = pasted;
    if (!firstPasted) return;

    if (pasted.length === 1 && firstPasted.type === 'paragraph') {
      // A single run of inline content — insert it at the cursor rather
      // than replacing the whole block; a heading/list/etc. result (even
      // if it's just one block) still goes through the block-level path
      // below, since inlining a heading into arbitrary running text
      // wouldn't make sense.
      document.execCommand('insertHTML', false, firstPasted.content);
      const updatedHtml = sanitizeInlineHtml(e.currentTarget.innerHTML);
      updateBlock(block.id, { content: updatedHtml });
      return;
    }

    onBlocksChange((prev) => {
      const idx = prev.findIndex((b) => b.id === block.id);
      if (idx === -1) return prev;
      const next = [...prev];
      if (block.content.trim() === '') {
        next.splice(idx, 1, ...pasted);
      } else {
        next.splice(idx + 1, 0, ...pasted);
      }
      return next;
    });

    const lastPasted = pasted[pasted.length - 1];
    if (lastPasted) requestAnimationFrame(() => focusBlock(lastPasted.id));
  };

  // Converts a block to a new type. `clearContent` is true for the slash
  // menu (the block's content at that point is just the "/query" text
  // that triggered the menu, meant to be discarded) and false for the
  // toolbar (the block may already hold real text the user typed — a
  // toolbar "make this a heading" action must never destroy it).
  const convertBlockType = useCallback(
    (blockId: string, type: PageBlockType, opts: { clearContent?: boolean } = {}) => {
      if (FILE_BACKED_TYPES.has(type)) {
        setFilePickerState({ blockId, kind: type as 'image' | 'file' });
        return;
      }

      if (type === 'divider') {
        // A divider block renders as a plain, non-editable <div> with no
        // data-block-id — trying to focus it afterward (like every other
        // conversion does) silently fails and leaves the cursor nowhere.
        // Insert a fresh empty paragraph right after it and focus that
        // instead, so typing can continue immediately.
        const newBlockId = randomUUID();
        onBlocksChange((prev) => {
          const idx = prev.findIndex((b) => b.id === blockId);
          const original = prev[idx];
          if (idx === -1 || !original) return prev;
          const next = [...prev];
          next.splice(idx, 1, { ...original, type: 'divider', content: '' }, { id: newBlockId, type: 'paragraph', content: '' });
          return next;
        });
        requestAnimationFrame(() => focusBlock(newBlockId));
        return;
      }

      updateBlock(blockId, { type, ...(opts.clearContent ? { content: '' } : {}) });
      requestAnimationFrame(() => focusBlock(blockId));
    },
    [updateBlock, onBlocksChange],
  );

  const pickSlashType = (type: PageBlockType) => {
    if (!slashState) return;
    const blockId = slashState.blockId;
    setSlashState(null);
    convertBlockType(blockId, type, { clearContent: true });
  };

  // Toolbar "insert image"/"insert file": adds a fresh block after
  // whichever one is currently focused (or at the end, if none is) and
  // opens the file picker for it — inserting media is additive, unlike
  // the block-type buttons which convert the focused block in place.
  const insertFileBlock = (kind: 'image' | 'file') => {
    const anchorId = focusedBlockId ?? blocks[blocks.length - 1]?.id;
    if (!anchorId) return;
    const newBlock: PageBlock = { id: randomUUID(), type: 'paragraph', content: '' };
    onBlocksChange((prev) => {
      const idx = prev.findIndex((b) => b.id === anchorId);
      const next = [...prev];
      next.splice(idx + 1, 0, newBlock);
      return next;
    });
    setFilePickerState({ blockId: newBlock.id, kind });
  };

  const handleFilePicked = (file: UserFileInfo) => {
    if (!filePickerState) return;
    const isImage = file.mimeType.startsWith('image/');
    updateBlock(filePickerState.blockId, {
      type: isImage ? 'image' : 'file',
      content: file.url,
      fileName: file.originalName,
    });
    setFilePickerState(null);
  };

  // Applies inline formatting to the current text selection. Uses
  // execCommand for the well-supported cases and manual Range surgery for
  // inline code and clearing formatting (no native command reliably does
  // either — execCommand('removeFormat') in particular is inconsistent
  // across browsers about which tags it strips, and doesn't touch links
  // at all in most of them) — see lib/sanitize.ts for why this stays
  // safe to store and re-render for other viewers.
  const applyFormat = (cmd: 'bold' | 'italic' | 'strikeThrough' | 'code' | 'link' | 'clearFormat') => {
    if (!focusedBlockId) return;
    const el = document.querySelector<HTMLElement>(`[data-block-id="${focusedBlockId}"]`);
    if (!el) return;
    el.focus();

    if (cmd === 'code') {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        const wrapper = document.createElement('code');
        try {
          range.surroundContents(wrapper);
        } catch {
          // Selection crosses element boundaries — skip rather than corrupt the DOM.
        }
        selection.removeAllRanges();
      }
    } else if (cmd === 'link') {
      const url = window.prompt('Ссылка (https://...)');
      if (!url) return;
      document.execCommand('createLink', false, url);
    } else if (cmd === 'clearFormat') {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed && el.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        // `range.toString()` is exactly the selection's visible plain
        // text, with every tag — bold, italic, strike, inline code,
        // link, even a katex-inline span — already stripped out by the
        // DOM itself; replacing the whole selected range with a single
        // text node of just that is a full "back to plain text" in one
        // step, unlike execCommand('removeFormat') which is inconsistent
        // about which of these it actually touches.
        const plainText = range.toString();
        range.deleteContents();
        range.insertNode(document.createTextNode(plainText));
        selection.removeAllRanges();
      }
    } else {
      document.execCommand(cmd);
    }

    const html = sanitizeInlineHtml(el.innerHTML);
    updateBlock(focusedBlockId, { content: html });
  };

  // Inserts a link to another document — PagePickerDialog (same one chat
  // attachments use) picks the page, then, for this flow specifically,
  // PageBlockPickerDialog optionally narrows it down to a single block
  // within that page, and this wires the result into the current
  // block's content.
  //
  // Two distinct outcomes depending on `pageRefFlow.selection` (captured
  // by the toolbar button's own onClick, before either dialog could
  // steal focus and collapse it — see that state's own doc comment):
  //   - There WAS a non-empty text selection: wrap exactly that text in
  //     an <a> in place, keeping it as the visible link text. This is
  //     the case the two-step picker above exists for — making an
  //     existing word or phrase ("разрешенная", say) into a link to
  //     wherever it's actually explained, in this document or another.
  //   - No selection (or none the flow could capture — e.g. the toolbar
  //     click already blurred the block on some mobile browsers):
  //     falls back to the original behavior, inserting a brand new
  //     "📄 Title" chip at the cursor (or appended at the end if there's
  //     nowhere else to put it). Unchanged from before this two-step
  //     flow existed.
  //
  // The reference has to survive sanitizeInlineHtml(), which strips
  // every attribute off an <a> except href/target/rel (see sanitize.ts —
  // a real stored-XSS concern, not overcautious) — so a custom
  // `data-page-ref`/`data-block-id` attribute is a non-starter. Instead
  // the reference is encoded *into* href itself as `/page-ref/{ownerId}/
  // {projectId}/{pageId}`, with an optional trailing `/{blockId}` when a
  // specific block was chosen — passes sanitizeInlineHtml's href safety
  // check (it allows any path starting with `/`, regardless of segment
  // count) untouched, and doesn't collide with a real route since
  // nothing in the app actually serves that path; handleLinkClick
  // recognizes the prefix and intercepts the click for in-app navigation
  // (plus scrolling to the target block, if any) instead of letting it
  // act like a normal link.
  const insertPageRefLink = (page: AttachedPageRef, targetBlockId: string | null) => {
    const flow = pageRefFlow;
    setPageRefFlow(null);
    if (!flow) return;
    const { blockId, selection } = flow;
    const el = document.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
    if (!el) return;
    el.focus();

    const href = `/page-ref/${page.ownerId}/${page.projectId}/${page.pageId}${targetBlockId ? `/${targetBlockId}` : ''}`;
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);

    if (selection) {
      const range = createRangeFromOffsets(el, selection.start, selection.end);
      if (range) {
        anchor.appendChild(range.extractContents());
        range.insertNode(anchor);
        range.setStartAfter(anchor);
        range.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    } else {
      anchor.textContent = `📄 ${page.title}`;
      const currentSelection = window.getSelection();
      const range =
        currentSelection && currentSelection.rangeCount > 0 && el.contains(currentSelection.anchorNode)
          ? currentSelection.getRangeAt(0)
          : null;
      if (range) {
        range.deleteContents();
        range.insertNode(anchor);
        range.setStartAfter(anchor);
        range.collapse(true);
        currentSelection?.removeAllRanges();
        currentSelection?.addRange(range);
      } else {
        // No active selection in this block (toolbar click blurred it,
        // common on mobile/some browsers) — append at the end rather than
        // silently dropping the link.
        el.appendChild(anchor);
      }
    }

    const html = sanitizeInlineHtml(el.innerHTML);
    updateBlock(blockId, { content: html });
  };

  // Drag-and-drop from the local machine goes through the same personal
  // file storage as clipboard-paste uploads (see uploadFileAndInsertBlock)
  // — one upload destination for every way of adding media, whether it's
  // an image (inserted as an image block) or any other file (inserted as
  // a downloadable file block). Multiple files dropped at once are
  // uploaded one at a time, in order.
  const handleDrop = async (e: React.DragEvent, afterId: string) => {
    e.preventDefault();
    setDragOverAssets(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;

    let anchorId = afterId;
    for (const file of files) {
      anchorId = await uploadFileAndInsertBlock(file, anchorId);
    }
  };

  // Moves `sourceId` to just before/after `targetId`. Built immutably (no
  // in-place splice on `prev`) since `prev` is the current React state.
  const reorderBlock = useCallback(
    (sourceId: string, targetId: string, position: 'before' | 'after') => {
      if (sourceId === targetId) return;
      onBlocksChange((prev) => {
        const moved = prev.find((b) => b.id === sourceId);
        if (!moved) return prev;

        const withoutSource = prev.filter((b) => b.id !== sourceId);
        const targetIdx = withoutSource.findIndex((b) => b.id === targetId);
        if (targetIdx === -1) return prev; // target vanished mid-drag — abort rather than guess

        const insertAt = position === 'before' ? targetIdx : targetIdx + 1;
        const next = [...withoutSource];
        next.splice(insertAt, 0, moved);
        return next;
      });
    },
    [onBlocksChange],
  );

  const handleBlockDragStart = (e: React.DragEvent, blockId: string) => {
    e.dataTransfer.setData(BLOCK_DRAG_MIME, blockId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleBlockDragEnd = () => {
    setDropTarget(null);
  };

  // Shared dragover for a block's container: distinguishes "another block
  // being reordered onto me" (shows the before/after line) from "an OS
  // file being dragged in" (falls through to the existing upload
  // highlight, handled by the caller). Anything else — notably the
  // browser's own native "drag selected text to move it" gesture within a
  // contentEditable block — is deliberately left alone: we only call
  // preventDefault() for drag types we actually handle, so native
  // in-place text dragging keeps working instead of being silently
  // swallowed by a drop handler that doesn't understand it.
  const handleBlockDragOver = (e: React.DragEvent, blockId: string) => {
    const isBlockDrag = e.dataTransfer.types.includes(BLOCK_DRAG_MIME);
    const isFileDrag = e.dataTransfer.types.includes('Files');
    if (!isBlockDrag && !isFileDrag) return;

    e.preventDefault();
    if (isBlockDrag) {
      const rect = e.currentTarget.getBoundingClientRect();
      const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      setDropTarget((prev) => (prev?.blockId === blockId && prev.position === position ? prev : { blockId, position }));
    }
  };

  const handleBlockDrop = (e: React.DragEvent, blockId: string) => {
    if (e.dataTransfer.types.includes(BLOCK_DRAG_MIME)) {
      e.preventDefault();
      const sourceId = e.dataTransfer.getData(BLOCK_DRAG_MIME);
      if (sourceId) reorderBlock(sourceId, blockId, dropTarget?.position ?? 'after');
      setDropTarget(null);
      return;
    }
    if (e.dataTransfer.types.includes('Files')) {
      void handleDrop(e, blockId);
    }
    // Anything else (e.g. a native text-selection drag) — don't intercept,
    // let the browser's own drop handling run.
  };

  // Manual numbering for numbered-list blocks — not derived from CSS's
  // `list-item` counter (which the `list-decimal` class alone would rely
  // on), because that counter is scoped to the whole document, not to
  // each consecutive run of numberedList blocks: two separate numbered
  // lists with a paragraph between them would show 1,2,3 then 4,5,6
  // instead of each restarting at 1. Resets to 0 on any non-numberedList
  // block, so each run starts fresh.
  const numberedListIndices = useMemo(() => {
    const map = new Map<string, number>();
    let counter = 0;
    for (const b of blocks) {
      if (b.type === 'numberedList') {
        counter += 1;
        map.set(b.id, counter);
      } else {
        counter = 0;
      }
    }
    return map;
  }, [blocks]);

  const keyboardInset = useKeyboardInset();

  return (
    <div
      ref={containerRef}
      id="print-root"
      className="mx-auto min-h-full w-full px-5 pb-32 pt-6 sm:px-16 md:pb-10"
      style={editorWidthStyle}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(BLOCK_DRAG_MIME)) return;
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) setDragOverAssets(true);
      }}
      onDragLeave={() => setDragOverAssets(false)}
    >
      {!readOnly && (
        <div
          role="toolbar"
          aria-label="Форматирование"
          // Телефон: панель прижата к низу экрана — над клавиатурой (см. useKeyboardInset), прокручивается вбок.
          style={keyboardInset ? { bottom: keyboardInset } : undefined}
          className="no-print fixed inset-x-0 bottom-0 z-30 flex flex-nowrap items-center gap-0.5 overflow-x-auto border-t border-line/[0.08] bg-surface-panel px-1.5 pt-1 md:backdrop-blur-md [padding-bottom:max(var(--safe-bottom),4px)] max-md:[&_button]:h-11 max-md:[&_button]:min-w-[44px] md:sticky md:inset-x-auto md:bottom-auto md:top-3 md:z-10 md:mb-6 md:w-fit md:max-w-full md:flex-wrap md:overflow-visible md:rounded-lg md:border-0 md:bg-surface-raised/90 md:p-1 md:shadow-pop"
        >
          {!isSourceView && (
            <>
              <BlockTypeDropdown
                currentType={blocks.find((b) => b.id === focusedBlockId)?.type ?? null}
                onSelect={(type) => focusedBlockId && convertBlockType(focusedBlockId, type)}
              />

              <ToolbarSeparator />

              <ToolbarButton icon={Bold} label="Жирный" onClick={() => applyFormat('bold')} />
              <ToolbarButton icon={Italic} label="Курсив" onClick={() => applyFormat('italic')} />
              <ToolbarButton icon={Strikethrough} label="Зачёркнутый" onClick={() => applyFormat('strikeThrough')} />
              <ToolbarButton icon={Code2} label="Код (инлайн)" onClick={() => applyFormat('code')} />
              <ToolbarButton icon={LinkIcon} label="Ссылка (открыть можно Ctrl/Cmd+клик)" onClick={() => applyFormat('link')} />
              <ToolbarButton icon={RemoveFormatting} label="Очистить форматирование" onClick={() => applyFormat('clearFormat')} />
              <ToolbarButton
                icon={FileSymlink}
                label="Ссылка на документ (свой или расшаренный) — выделите текст, чтобы сделать его ссылкой"
                onClick={() => {
                  if (!focusedBlockId) return;
                  const el = document.querySelector<HTMLElement>(`[data-block-id="${focusedBlockId}"]`);
                  const domSelection = window.getSelection();
                  let selection: { start: number; end: number } | null = null;
                  if (el && domSelection && domSelection.rangeCount > 0 && !domSelection.isCollapsed && el.contains(domSelection.anchorNode)) {
                    const offsets = getRangeOffsetsWithin(el, domSelection.getRangeAt(0));
                    if (offsets.end > offsets.start) selection = offsets;
                  }
                  setPageRefFlow({ blockId: focusedBlockId, selection, targetPage: null });
                }}
              />

              <ToolbarSeparator />
            </>
          )}

          <ToolbarButton
            icon={SquareCode}
            label={isSourceView ? 'Вернуться к обычному виду' : 'Просмотр исходного кода страницы'}
            onClick={() => {
              if (isSourceView) {
                // Leaving — parse whatever was typed/edited back into
                // blocks. htmlToBlocks() already sanitizes and normalizes
                // as part of parsing (it's the same function pasted
                // content goes through), so there's no separate
                // sanitize-on-exit step needed here the way the old
                // per-block version had. Falls back to a single empty
                // paragraph if the result would otherwise be zero blocks
                // (clearing the textarea entirely and exiting) — nothing
                // else in the editor expects a document with no blocks
                // at all; a brand new page always starts with exactly one.
                const parsed = htmlToBlocks(sourceText);
                onBlocksChange(parsed.length > 0 ? parsed : [{ id: randomUUID(), type: 'paragraph', content: '' }]);
                setIsSourceView(false);
              } else {
                setSourceText(blocksToFormattedSourceHtml(blocks));
                setIsSourceView(true);
              }
            }}
          />

          <ToolbarSeparator />

          {!isSourceView && (
            <>
              <ToolbarButton icon={ImageIcon} label="Вставить изображение" onClick={() => insertFileBlock('image')} />
              <ToolbarButton icon={Paperclip} label="Прикрепить файл" onClick={() => insertFileBlock('file')} />
            </>
          )}
        </div>
      )}

      {/* Шапка документа: обложка (необязательно), крупный ярлык страницы
          и заголовок рядом с ним. При наличии обложки ярлык «наезжает» на
          её нижний край — так он визуально связывает обложку и заголовок. */}
      {cover && (
        <div className="relative -mx-6 h-48 overflow-hidden rounded-xl sm:-mx-16 sm:h-60">
          <div
            className="absolute inset-0"
            style={
              isCoverColor(cover)
                ? { backgroundColor: resolveCoverColorHex(cover, isDarkTheme) }
                : { backgroundImage: `url(${withAuthToken(cover)})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            }
          />
          {!isCoverColor(cover) && <div className="absolute inset-0 bg-gradient-to-t from-black/25 to-transparent" />}
          {!readOnly && (
            <div className="no-print absolute right-3 top-3 z-10 flex items-center gap-1.5">
              {icon === '' && (
                <div
                  className={clsx(
                    'rounded-md backdrop-blur-md [&_button]:!text-current',
                    coverTextColor === 'dark' ? 'bg-white/60 text-ink' : 'bg-black/30 text-white',
                  )}
                >
                  <PageIconPicker icon={icon} onChange={onIconChange} variant="add-button" />
                </div>
              )}
              <button
                type="button"
                onClick={() => setCoverPickerOpen((v) => !v)}
                ref={coverButtonRef}
                className={clsx(
                  'rounded-md px-2.5 py-1.5 text-xs font-medium backdrop-blur-md transition-colors',
                  coverTextColor === 'dark' ? 'bg-white/60 text-ink hover:bg-white/80' : 'bg-black/30 text-white hover:bg-black/50',
                )}
              >
                Изменить обложку
              </button>
            </div>
          )}
          {coverPickerOpen && (
            <PageCoverPicker
              cover={cover}
              onChange={onCoverChange}
              uploadCoverImage={uploadCoverImage}
              onClose={() => setCoverPickerOpen(false)}
              anchorRef={coverButtonRef}
            />
          )}
        </div>
      )}

      {!cover && !readOnly && (
        <div className="no-print mb-3 flex items-center gap-1">
          {icon === '' && <PageIconPicker icon={icon} onChange={onIconChange} variant="add-button" />}
          <button
            type="button"
            onClick={() => setCoverPickerOpen((v) => !v)}
            ref={coverButtonRef}
            className="relative flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <ImagePlus size={14} />
            Добавить обложку
            {coverPickerOpen && (
              <PageCoverPicker
                cover={cover}
                onChange={onCoverChange}
                uploadCoverImage={uploadCoverImage}
                onClose={() => setCoverPickerOpen(false)}
                anchorRef={coverButtonRef}
              />
            )}
          </button>
        </div>
      )}

      <div
        className={clsx(
          'flex flex-col items-start gap-4 sm:flex-row sm:gap-6',
          cover ? '-mt-12 sm:-mt-14 sm:items-end' : 'sm:items-center',
        )}
      >
        {icon !== '' && (icon || !readOnly) && (
          <div
            className={clsx(
              'relative shrink-0 rounded-2xl',
              cover && 'bg-surface p-1.5 shadow-pop ring-1 ring-line/[0.06]',
            )}
          >
            <PageIconPicker icon={icon} onChange={onIconChange} readOnly={readOnly} size={112} />
          </div>
        )}
        <div className={clsx('w-full min-w-0 flex-1', cover && icon !== '' && 'sm:pb-1', cover && (icon === '' || (!icon && readOnly)) && 'pt-14 sm:pt-16')}>
          <EditableTitle
            title={title}
            onTitleChange={onTitleChange}
            readOnly={readOnly}
            onEnter={() => focusBlock(blocks[0]?.id ?? '')}
          />
        </div>
      </div>

      {isSourceView ? (
        <textarea
          autoFocus
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          spellCheck={false}
          className="input mt-4 min-h-[60vh] resize-y py-3 font-mono text-xs leading-6"
        />
      ) : (
        <div className={clsx('mt-6 flex flex-col gap-0.5 rounded-lg transition-colors', dragOverAssets && 'bg-accent-soft/30 ring-2 ring-accent/30')}>
          {blocks.map((block) => (
            <Fragment key={block.id}>
              <BlockRow
                block={block}
                readOnly={readOnly}
                isHighlighted={block.id === highlightedBlockId}
              numberedListIndex={block.type === 'numberedList' ? numberedListIndices.get(block.id) : undefined}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onLinkClick={handleLinkClick}
              onPaste={handlePaste}
              onFocus={() => setFocusedBlockId(block.id)}
              onToggleTodo={() => updateBlock(block.id, { checked: !block.checked })}
              onFormulaChange={(content) => updateBlock(block.id, { content })}
              onAddBelow={() => insertBlockAfter(block.id)}
              onRemove={() => removeBlock(block.id)}
              onDrop={(e) => handleBlockDrop(e, block.id)}
              onDragOverBlock={(e) => handleBlockDragOver(e, block.id)}
              onGripDragStart={(e) => handleBlockDragStart(e, block.id)}
              onGripDragEnd={handleBlockDragEnd}
              dropIndicator={dropTarget && dropTarget.blockId === block.id ? dropTarget.position : null}
              isSelected={selectedBlockIds?.has(block.id) ?? false}
              onContentMouseDown={(e) => handleContentMouseDown(e, block.id)}
            />
            {pendingUploads
              .filter((p) => p.anchorId === block.id)
              .map((p) => (
                <div key={p.id} className="my-1 flex items-center gap-2 rounded-md border border-line/10 bg-surface-hover px-3 py-2 text-sm text-ink-muted">
                  <Loader2 size={14} className="animate-spin" />
                  Загрузка изображения...
                </div>
              ))}
          </Fragment>
        ))}
      </div>
      )}

      {slashState && (
        <SlashMenu
          query={slashState.query}
          activeIndex={activeSlashIndex}
          position={slashState.position}
          onPick={pickSlashType}
        />
      )}

      {filePickerState && (
        <FilePickerDialog
          onClose={() => setFilePickerState(null)}
          onPick={handleFilePicked}
          imagesOnly={filePickerState.kind === 'image'}
        />
      )}
      {pageRefFlow && !pageRefFlow.targetPage && (
        <PagePickerDialog
          currentUserId={currentUserId}
          onClose={() => setPageRefFlow(null)}
          onPick={(page) => setPageRefFlow((prev) => (prev ? { ...prev, targetPage: page } : prev))}
        />
      )}
      {pageRefFlow?.targetPage && (
        <PageBlockPickerDialog
          page={pageRefFlow.targetPage}
          onBack={() => setPageRefFlow((prev) => (prev ? { ...prev, targetPage: null } : prev))}
          onClose={() => setPageRefFlow(null)}
          onPick={(blockId) => insertPageRefLink(pageRefFlow.targetPage!, blockId)}
        />
      )}
    </div>
  );
}

// Block types a user can convert the focused block into via the toolbar
// dropdown. Image/file are excluded — those insert a fresh block (see the
// dedicated toolbar buttons) rather than converting the current one.
const BLOCK_TYPE_OPTIONS = SLASH_OPTIONS.filter((o) => !FILE_BACKED_TYPES.has(o.type));

/**
 * First item in the toolbar: a single dropdown for the focused block's
 * type, mirroring the slash menu (including "Текст"/paragraph, which had
 * no toolbar equivalent before — converting a heading back to a plain
 * paragraph required either Backspace-ing through the whole heading or
 * reaching for the slash menu mid-edit).
 */
function BlockTypeDropdown({
  currentType,
  onSelect,
}: {
  currentType: PageBlockType | null;
  onSelect: (type: PageBlockType) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const fallback = BLOCK_TYPE_OPTIONS[0];
  if (!fallback) return null; // BLOCK_TYPE_OPTIONS is never actually empty — just keeping TS happy

  const current = BLOCK_TYPE_OPTIONS.find((o) => o.type === currentType) ?? fallback;
  const CurrentIcon = current.icon;
  const disabled = !currentType;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Тип блока"
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        <CurrentIcon size={14} />
        <span className="max-w-[110px] truncate">{current.label}</span>
        <ChevronDown size={12} />
      </button>

      {open && !disabled && (
        <div className="popover z-40 overflow-hidden p-0 max-md:fixed max-md:inset-x-2 max-md:bottom-[calc(var(--safe-bottom)+64px)] md:absolute md:left-0 md:top-full md:z-20 md:mt-1.5 md:w-56">
          <div className="max-h-72 overflow-y-auto p-1">
            {BLOCK_TYPE_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.type}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onSelect(opt.type);
                    setOpen(false);
                  }}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm',
                    opt.type === currentType ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                  )}
                >
                  <Icon size={14} />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolbarSeparator() {
  return <div className="mx-1 h-4 w-px shrink-0 bg-line/[0.1]" />;
}

/**
 * A genuinely inline-flowing contentEditable title, not a `<textarea>` —
 * needed specifically so the page icon can `float: left` next to it with
 * real CSS text-wrap: the first lines narrow around the float, and once
 * the text extends past the float's height, later lines reflow to the
 * full width again. A `<textarea>` can't do this at all (it's a
 * replaced element with its own fixed rectangular box, not something
 * floats affect the internal line-wrapping of) — this is the reason the
 * title needed converting in the first place, not just a style change.
 *
 * Same uncontrolled-DOM-synced-via-ref pattern as EditableBlockContent
 * for block content, simplified: title is always plain text (this app's
 * titles were never rich text to begin with — the `<textarea>` this
 * replaces couldn't hold formatting either). Enter doesn't insert a newline — titles are conceptually a
 * single logical line even when it visually wraps — it moves focus into
 * the first content block instead, mirroring how tabbing "down" out of
 * a title works in most document editors.
 */
function EditableTitle({
  title,
  onTitleChange,
  readOnly,
  onEnter,
  onCover,
}: {
  title: string;
  onTitleChange: (title: string) => void;
  readOnly?: boolean;
  onEnter: () => void;
  /** When set, this title renders overlaid on a cover banner (see the cover-image/color block above it) rather than the plain page background — 'white' for a dark cover or any image (the gradient overlay guarantees a dark-enough area), 'dark' for a light solid-color preset. Omitted entirely (undefined) for the plain no-cover case. */
  onCover?: 'white' | 'dark';
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.textContent !== title) {
      el.textContent = title;
    }
  }, [title]);

  return (
    <div
      ref={ref}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      onInput={readOnly ? undefined : (e) => onTitleChange(e.currentTarget.textContent ?? '')}
      onKeyDown={
        readOnly
          ? undefined
          : (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onEnter();
              }
            }
      }
      onPaste={
        readOnly
          ? undefined
          : (e) => {
              // Forces plain text even if the clipboard carries rich HTML —
              // without this, a pasted <b>word</b> would keep rendering bold
              // even though .textContent (what onInput/onTitleChange actually
              // read) can't tell the difference from plain "word" at all, so
              // the usual sync-effect-cleans-it-up safety net the rest of this
              // component relies on wouldn't catch it here.
              e.preventDefault();
              document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
            }
      }
      data-placeholder={title === '' ? 'Без названия' : undefined}
      style={{ whiteSpace: 'pre-wrap' }}
      className={clsx(
        'min-h-[1.2em] break-words text-[36px] font-bold leading-[1.15] tracking-[-0.025em] outline-none sm:text-[40px]',
        onCover === 'white'
          ? 'text-white empty:before:text-white/60 empty:before:content-[attr(data-placeholder)]'
          : 'text-ink empty:before:text-ink-faint empty:before:content-[attr(data-placeholder)]',
      )}
    />
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      // Prevents the mousedown from stealing focus/selection away from the
      // contentEditable block before the click handler can act on it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
    >
      <Icon size={15} />
    </button>
  );
}

function BlockRow({
  block,
  readOnly,
  numberedListIndex,
  onInput,
  onKeyDown,
  onLinkClick,
  onPaste,
  onFocus,
  onToggleTodo,
  onAddBelow,
  onRemove,
  onDrop,
  onDragOverBlock,
  onGripDragStart,
  onGripDragEnd,
  dropIndicator,
  isSelected,
  isHighlighted,
  onContentMouseDown,
  onFormulaChange,
}: {
  block: PageBlock;
  readOnly?: boolean;
  /** Only meaningful for numberedList blocks — the manually-computed position within its consecutive run (see the numberedListIndices doc comment in the parent for why this isn't left to a CSS counter). */
  numberedListIndex?: number;
  onInput: (e: React.FormEvent<HTMLElement>, block: PageBlock) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>, block: PageBlock) => void;
  onLinkClick: (e: React.MouseEvent<HTMLElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLElement>, block: PageBlock) => void;
  onFocus: () => void;
  onToggleTodo: () => void;
  onAddBelow: () => void;
  onRemove: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragOverBlock: (e: React.DragEvent) => void;
  onGripDragStart: (e: React.DragEvent) => void;
  onGripDragEnd: () => void;
  dropIndicator: 'before' | 'after' | null;
  isSelected: boolean;
  /** True for the couple seconds right after navigating here via a page-reference link that targeted this specific block — see the `scrollToBlockId` effect in the parent. */
  isHighlighted?: boolean;
  onContentMouseDown: (e: React.MouseEvent) => void;
  onFormulaChange: (content: string) => void;
}) {
  const Tag = BLOCK_TAG[block.type] as keyof JSX.IntrinsicElements;

  const renderContent = () => {
    if (block.type === 'divider') {
      return <div className={BLOCK_CLASS.divider} />;
    }

    if (block.type === 'image') {
      return (
        <ImageBlockView url={withAuthToken(block.content)} name={block.fileName ?? ''} zoomable={!!readOnly} />
      );
    }

    if (block.type === 'formula') {
      return (
        <FormulaBlockContent
          blockId={block.id}
          content={block.content}
          readOnly={readOnly}
          onChange={onFormulaChange}
          onFocus={onFocus}
        />
      );
    }

    if (block.type === 'file') {
      return <FileBlockCard url={block.content} name={block.fileName ?? 'Файл'} />;
    }

    return (
      <div className="flex items-start gap-1">
        {block.type === 'todo' && (
          <input
            type="checkbox"
            checked={!!block.checked}
            onChange={readOnly ? undefined : onToggleTodo}
            disabled={readOnly}
            className="mt-[7px] h-[16px] w-[16px] shrink-0 cursor-pointer rounded accent-[rgb(var(--accent))]"
          />
        )}
        {block.type === 'numberedList' && (
          <span className="min-w-[1.5em] shrink-0 text-right text-[16px] leading-[1.75] tabular-nums text-ink-muted">{numberedListIndex ?? 1}.</span>
        )}
        {block.type === 'bulletList' && <span className="flex h-[28px] w-[1.1em] shrink-0 items-center justify-center"><span className="h-[5px] w-[5px] rounded-full bg-ink/70" /></span>}
        <EditableBlockContent
          block={block}
          Tag={Tag}
          readOnly={readOnly}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onLinkClick={onLinkClick}
          onPaste={onPaste}
          onFocus={onFocus}
          className={clsx(
            BLOCK_CLASS[block.type],
            'w-full flex-1 outline-none empty:before:text-ink-faint empty:before:content-[attr(data-placeholder)]',
            (block.type === 'bulletList' || block.type === 'numberedList') && 'list-none',
            block.checked && 'text-ink-faint line-through',
          )}
        />
      </div>
    );
  };

  return (
    <div
      data-block-row-id={block.id}
      className={clsx(
        'editor-block group relative flex items-start gap-1 rounded-md transition-colors duration-500 first:mt-0 sm:gap-0',
        BLOCK_SPACING[block.type],
        isHighlighted ? 'bg-accent-soft ring-2 ring-accent' : isSelected ? 'bg-accent-soft/50' : '',
      )}
      onDrop={readOnly ? undefined : onDrop}
      onDragOver={readOnly ? undefined : onDragOverBlock}
    >
      {dropIndicator === 'before' && <div className="pointer-events-none absolute -top-0.5 left-1 right-1 h-0.5 rounded bg-accent" />}
      {dropIndicator === 'after' && <div className="pointer-events-none absolute -bottom-0.5 left-1 right-1 h-0.5 rounded bg-accent" />}

      {!readOnly && (
        <div className="no-print mt-[3px] flex shrink-0 items-center gap-px opacity-0 transition-opacity group-hover:opacity-100 sm:absolute sm:right-full sm:top-0 sm:mr-1.5">
          <button type="button" onClick={onAddBelow} className="flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-surface-hover hover:text-ink" title="Добавить блок ниже">
            <Plus size={16} />
          </button>
          <span
            draggable
            onDragStart={onGripDragStart}
            onDragEnd={onGripDragEnd}
            className="flex h-6 w-5 cursor-grab items-center justify-center rounded text-ink-faint hover:bg-surface-hover hover:text-ink active:cursor-grabbing"
            title="Перетащить, чтобы изменить порядок"
          >
            <GripVertical size={15} />
          </span>
        </div>
      )}

      <div className="min-w-0 flex-1" onMouseDown={readOnly ? undefined : onContentMouseDown}>
        {renderContent()}
      </div>

      {!readOnly && (
        <button
          type="button"
          onClick={onRemove}
          className="no-print mt-[3px] flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-danger group-hover:opacity-100 sm:absolute sm:left-full sm:top-0 sm:ml-1.5"
          title="Удалить блок"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * Renders the actual contentEditable element for a block, syncing
 * `block.content` into the DOM imperatively instead of via a reactive
 * `dangerouslySetInnerHTML` prop.
 *
 * Why: `handleInput` in the parent updates React state on every keystroke.
 * If the element's HTML were driven declaratively by that state (a fresh
 * `{ __html: block.content }` object every render), React would compare
 * the new string against its last-committed one — which differ by
 * definition, since content just grew by one character — and reset
 * `innerHTML` in the DOM to "catch up". Resetting `innerHTML` on a live
 * contentEditable destroys and recreates its text nodes, which drops the
 * browser's selection/cursor even though the content ends up identical to
 * what was already there. That's the classic React+contentEditable
 * cursor-jump bug.
 *
 * The fix: only touch the DOM when `block.content` changed for a reason
 * OTHER than this element's own typing (a slash-command changed the block
 * type, a file was picked, a formatting button ran `execCommand` outside
 * the normal input flow, or — down the line — a collaborator's edit
 * arrived over the realtime channel). The `useEffect` below runs after
 * every render but is a no-op whenever the DOM already matches, which is
 * always true right after the user's own keystroke, since `handleInput`
 * derives the new state from `el.innerHTML` in the first place.
 */
/** Картинка статьи; в режиме чтения клик открывает её на весь экран. */
function ImageBlockView({ url, name, zoomable }: { url: string; name: string; zoomable: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name}
        onClick={zoomable ? () => setOpen(true) : undefined}
        className={clsx('my-3 max-h-[520px] rounded-lg border border-line/[0.08] object-contain shadow-xs', zoomable && 'cursor-zoom-in')}
      />
      {open && <FilePreviewDialog file={{ url, name: name || 'Изображение', mimeType: 'image/*' }} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Блок «Файл»: клик открывает просмотр в модальном окне, а не новую вкладку. */
function FileBlockCard({ url, name }: { url: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-1.5 flex w-full items-center gap-3 rounded-lg border border-line/[0.08] bg-surface-raised px-3 py-2.5 text-left text-sm shadow-xs transition-colors hover:bg-surface-hover"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
          <FileText size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ink">{name}</span>
        <Eye size={14} className="shrink-0 text-ink-faint" />
      </button>
      {open && <FilePreviewDialog file={{ url, name, mimeType: '' }} onClose={() => setOpen(false)} />}
    </>
  );
}

function EditableBlockContent({
  block,
  Tag,
  readOnly,
  onInput,
  onKeyDown,
  onLinkClick,
  onPaste,
  onFocus,
  className,
}: {
  block: PageBlock;
  Tag: keyof JSX.IntrinsicElements;
  readOnly?: boolean;
  onInput: (e: React.FormEvent<HTMLElement>, block: PageBlock) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>, block: PageBlock) => void;
  onLinkClick: (e: React.MouseEvent<HTMLElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLElement>, block: PageBlock) => void;
  onFocus: () => void;
  className: string;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.innerHTML !== block.content) {
      el.innerHTML = block.content;
    }
    if (el) hydrateInlineFormulas(el);
    // `Tag` matters here, not just `block.content`: converting a block's
    // type (e.g. H1 → H2) changes the rendered tag, and a different tag
    // means React unmounts the old DOM node and mounts a fresh, empty
    // one — content-preserving conversions leave `block.content` itself
    // unchanged, so without `Tag` in the deps this effect wouldn't
    // re-run and the freshly-mounted element would stay empty until
    // something else (a full page reload) remounted it with the initial
    // content already synced.
  }, [block.content, Tag]);

  // `Tag` is picked at runtime from a lookup table, so its exact element
  // type (HTMLParagraphElement vs HTMLLIElement vs...) isn't known
  // statically. Casting to `any` here avoids fighting TypeScript's
  // per-intrinsic-element prop/ref typing for what is, functionally, the
  // same handful of props on every branch.
  const DynamicTag = Tag as any;

  return (
    <DynamicTag
      ref={ref}
      data-block-id={block.id}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      onInput={readOnly ? undefined : (e: React.FormEvent<HTMLElement>) => onInput(e, block)}
      onKeyDown={readOnly ? undefined : (e: React.KeyboardEvent<HTMLElement>) => onKeyDown(e, block)}
      onPaste={readOnly ? undefined : (e: React.ClipboardEvent<HTMLElement>) => onPaste(e, block)}
      onClick={onLinkClick}
      onFocus={readOnly ? undefined : onFocus}
      data-placeholder={block.content === '' ? placeholderFor(block.type) : undefined}
      className={className}
    />
  );
}

function placeholderFor(type: PageBlockType): string {
  switch (type) {
    case 'heading1':
    case 'heading2':
    case 'heading3':
      return 'Заголовок';
    case 'todo':
      return 'Задача';
    case 'code':
      return 'Код...';
    case 'callout':
      return 'Заметка...';
    default:
      return "Напишите '/' для команд...";
  }
}

/**
 * Телефон: сколько пикселей снизу занимает экранная клавиатура (через
 * visualViewport) — чтобы панель форматирования стояла прямо над ней, а не
 * пряталась под клавиатурой. На компьютере и без клавиатуры — 0.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      if (window.innerWidth >= 768) return setInset(0);
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      setInset(covered > 80 ? Math.round(covered) : 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}
