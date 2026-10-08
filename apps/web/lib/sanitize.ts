/**
 * Allowlist sanitizer for the small set of inline formatting tags the
 * editor's toolbar produces (bold/italic/strike/code/link/line-break),
 * plus the `<span class="katex-inline" data-latex="...">` markers
 * `wrapInlineFormulas()` in `pasteToBlocks.ts` inserts for inline math.
 * Content is user-typed rich text that gets rendered with
 * dangerouslySetInnerHTML for every viewer of a page — including people a
 * document is *shared* with — so this is a real stored-XSS surface, not
 * just cosmetic cleanup.
 *
 * Anything not explicitly allowed is stripped down to its text content.
 * This runs client-side, at the point content leaves the contentEditable
 * element (see Editor.tsx) — including on every single keystroke, not
 * just paste, so an inline-math span must survive this or it would
 * vanish the moment the user edits anywhere else in the same block. It
 * is not a substitute for server-side sanitization — a caller hitting
 * the API directly could still store arbitrary HTML — see agent.md for
 * that known gap.
 */
const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'S', 'STRIKE', 'U', 'CODE', 'A', 'BR']);

export function sanitizeInlineHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  sanitizeNode(template.content);
  stripZeroWidthSpaces(template.content);
  return template.innerHTML;
}

/**
 * Removes any zero-width space (U+200B) from text node content. Nothing
 * in this app deliberately stores one in `block.content` today — an
 * earlier version of `tryConvertInlineMarkdown()` (Editor.tsx) used one
 * as a caret-landing spot right after converting `*text*`/`_text_`/etc.
 * into a real tag, but it leaked into permanent storage and stuck around
 * even after the surrounding formatting was later removed, silently
 * breaking substring search on whatever word it landed inside (e.g.
 * "разреш\u200Bенная" no longer matching a search for "разрешенная").
 * That call site no longer inserts one (see its own doc comment), but
 * this sweep runs on every edit regardless of where a stray one might
 * come from — self-heals a block that already has one baked in from
 * before that fix the next time it's edited and saved, and guards
 * against any other future source (a paste from elsewhere, etc.).
 */
function stripZeroWidthSpaces(root: DocumentFragment | HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toRemove: Text[] = [];
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (node.textContent && node.textContent.includes('\u200B')) {
      const cleaned = node.textContent.replace(/\u200B/g, '');
      if (cleaned === '') {
        toRemove.push(node);
      } else {
        node.textContent = cleaned;
      }
    }
    node = walker.nextNode() as Text | null;
  }
  // Removed as a second pass rather than during the walk — mutating a
  // node the TreeWalker is currently positioned on, or one adjacent to
  // it, can make it skip the next node entirely.
  for (const n of toRemove) n.remove();
}

/** A `<span>` only survives this sanitizer if it's one of our own katex-inline markers — every other span (arbitrary content from other apps' clipboard HTML) still gets unwrapped down to its text content, same as before this tag was introduced. */
function isKatexInlineSpan(el: Element): boolean {
  return el.tagName === 'SPAN' && el.hasAttribute('data-latex');
}

function sanitizeNode(root: DocumentFragment | HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const toUnwrap: Element[] = [];
  const toRemoveAttrs: Element[] = [];

  let node = walker.nextNode() as Element | null;
  while (node) {
    if (!ALLOWED_TAGS.has(node.tagName) && !isKatexInlineSpan(node)) {
      toUnwrap.push(node);
    } else {
      toRemoveAttrs.push(node);
    }
    node = walker.nextNode() as Element | null;
  }

  for (const el of toRemoveAttrs) {
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      const safeHref = /^(https?:\/\/|\/)/i.test(href) ? href : '#';
      for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
      el.setAttribute('href', safeHref);
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    } else if (isKatexInlineSpan(el)) {
      // data-latex is only ever read back through KaTeX's own renderer
      // with trust:false (see FormulaBlock.tsx) — it's never interpreted
      // as HTML, so no attribute-escaping concern beyond what
      // getAttribute/setAttribute already handle correctly on their own.
      const latex = el.getAttribute('data-latex') ?? '';
      for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
      el.setAttribute('class', 'katex-inline');
      el.setAttribute('data-latex', latex);
      // Marks it non-editable so the caret can't land inside — an
      // editing-context detail that doesn't belong in stored content
      // (read-only viewers don't need it), added back by
      // hydrateInlineFormulas() in FormulaBlock.tsx instead. Any leftover
      // hydration marker from before this sanitize pass ran is dropped
      // here (not re-added by this function) so a subsequently-changed
      // data-latex value gets re-rendered rather than skipped as
      // "already hydrated".
    } else {
      for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
    }
  }

  // Replace disallowed elements with their text content (deepest-first so
  // nested disallowed tags don't resurrect themselves via a parent's
  // outerHTML replacement).
  for (const el of toUnwrap.reverse()) {
    el.replaceWith(...Array.from(el.childNodes));
  }
}
