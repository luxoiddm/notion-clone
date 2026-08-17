/**
 * Allowlist sanitizer for the small set of inline formatting tags the
 * editor's toolbar produces (bold/italic/strike/code/link/line-break).
 * Content is user-typed rich text that gets rendered with
 * dangerouslySetInnerHTML for every viewer of a page — including people a
 * document is *shared* with — so this is a real stored-XSS surface, not
 * just cosmetic cleanup.
 *
 * Anything not explicitly allowed is stripped down to its text content.
 * This runs client-side, at the point content leaves the contentEditable
 * element (see Editor.tsx). It is not a substitute for server-side
 * sanitization — a caller hitting the API directly could still store
 * arbitrary HTML — see agent.md for that known gap.
 */
const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'S', 'STRIKE', 'U', 'CODE', 'A', 'BR']);

export function sanitizeInlineHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  sanitizeNode(template.content);
  return template.innerHTML;
}

function sanitizeNode(root: DocumentFragment | HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const toUnwrap: Element[] = [];
  const toRemoveAttrs: Element[] = [];

  let node = walker.nextNode() as Element | null;
  while (node) {
    if (!ALLOWED_TAGS.has(node.tagName)) {
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
