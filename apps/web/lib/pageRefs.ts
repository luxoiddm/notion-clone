export interface PageRefLocation {
  ownerId: string;
  projectId: string;
  pageId: string;
}

// Matches exactly what Editor.tsx's insertPageRefLink() writes:
// href="/page-ref/{ownerId}/{projectId}/{pageId}". IDs are UUIDs (hex and
// dashes only), so there's no HTML-entity-encoding concern to worry about
// in the raw stored HTML this runs against.
const PAGE_REF_PATTERN = /href="\/page-ref\/([^/"]+)\/([^/"]+)\/([^/"]+)"/g;

/**
 * Extracts every unique document referenced anywhere in the page's
 * content — the editor sidebar's "related documents" section is driven
 * entirely by this scan, not by separately-tracked state, so a link
 * appearing in the text and appearing in the sidebar can never drift out
 * of sync with each other.
 */
export function extractPageRefs(blocks: { content: string }[]): PageRefLocation[] {
  const seen = new Set<string>();
  const refs: PageRefLocation[] = [];

  for (const block of blocks) {
    for (const match of block.content.matchAll(PAGE_REF_PATTERN)) {
      const [, ownerId, projectId, pageId] = match;
      if (!ownerId || !projectId || !pageId) continue;
      const key = `${ownerId}:${projectId}:${pageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ ownerId, projectId, pageId });
    }
  }

  return refs;
}
