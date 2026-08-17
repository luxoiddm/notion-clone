import type { PageBlock } from './types';
import { htmlToMarkdown } from './pasteToBlocks';

/** Resolves a relative asset URL (image/file blocks store a path like `/api/storage/...`) to an absolute one — the exported file is a portable snapshot read outside the app, where a relative path means nothing. Doesn't attempt to embed the asset itself (e.g. as base64); the link still requires being logged in to actually load, same as the editor's own image/file rendering already does via withAuthToken. */
function resolveAssetUrl(path: string): string {
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return path;
  }
}

function blockToMarkdown(block: PageBlock): string {
  const inline = (html: string) => htmlToMarkdown(html);

  switch (block.type) {
    case 'heading1':
      return `# ${inline(block.content)}`;
    case 'heading2':
      return `## ${inline(block.content)}`;
    case 'heading3':
      return `### ${inline(block.content)}`;
    case 'bulletList':
      return `- ${inline(block.content)}`;
    case 'numberedList':
      return `1. ${inline(block.content)}`;
    case 'todo':
      return `- [${block.checked ? 'x' : ' '}] ${inline(block.content)}`;
    case 'callout':
      return `> ${inline(block.content)}`;
    case 'code':
      // Code content is stored as plain text, not inline-formatted HTML
      // like every other block type — bold/italic inside code makes no
      // sense, so it never goes through the inline HTML→Markdown step.
      return `\`\`\`${block.language ?? ''}\n${block.content}\n\`\`\``;
    case 'divider':
      return '---';
    case 'image':
      return `![${block.fileName ?? ''}](${resolveAssetUrl(block.content)})`;
    case 'file':
      return `[${block.fileName ?? 'Файл'}](${resolveAssetUrl(block.content)})`;
    case 'paragraph':
    case 'table': // no real table UI exists yet (see SlashMenu/Editor) — content is plain paragraph HTML, treated the same
    default:
      return inline(block.content);
  }
}

export function documentToMarkdown(title: string, blocks: PageBlock[]): string {
  const lines = [`# ${title || 'Untitled'}`, ''];
  for (const block of blocks) {
    const md = blockToMarkdown(block);
    if (md.trim()) lines.push(md, '');
  }
  return lines.join('\n').trim() + '\n';
}

/** Strips ALL formatting, unlike documentToMarkdown — plain text needs no inline-markdown conversion at all, just readable prefixes for structure (bullets, checkboxes, a divider line). */
export function documentToPlainText(title: string, blocks: PageBlock[]): string {
  const lines = [title || 'Untitled', ''];
  // Same reasoning as Editor.tsx's numberedListIndices — computed per
  // consecutive run, not a flat per-document counter, so a second
  // numbered list later in the same page restarts at 1 rather than
  // continuing from wherever the first one left off.
  let numberedListCounter = 0;

  for (const block of blocks) {
    if (block.type !== 'numberedList') numberedListCounter = 0;

    if (block.type === 'divider') {
      lines.push('---', '');
      continue;
    }
    if (block.type === 'image' || block.type === 'file') {
      lines.push(`[${block.fileName ?? 'файл'}] ${resolveAssetUrl(block.content)}`, '');
      continue;
    }

    // Safe here — only ever called from a click handler (the export
    // button), a genuine user interaction where `document` is
    // guaranteed to exist, unlike inside a render-time useMemo (see
    // lib/tableOfContents.ts's doc comment for why that distinction
    // matters).
    const div = document.createElement('div');
    div.innerHTML = block.content;
    const text = (div.textContent ?? '').trim();
    if (!text) continue;

    const prefix =
      block.type === 'todo'
        ? `[${block.checked ? 'x' : ' '}] `
        : block.type === 'bulletList'
          ? '• '
          : block.type === 'numberedList'
            ? `${++numberedListCounter}. `
            : block.type === 'callout'
              ? '> '
              : '';
    lines.push(prefix + text, '');
  }

  return lines.join('\n').trim() + '\n';
}

/** Triggers a browser download of `content` as a file — no server round-trip, the export is assembled entirely client-side from blocks already loaded in the editor. */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Sanitizes a page title into a safe filename — strips characters that are invalid across major OSes (not just the current one), since the file will very often be moved between them. */
export function sanitizeFilename(title: string): string {
  const cleaned = title.trim().replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ');
  return cleaned || 'Untitled';
}
