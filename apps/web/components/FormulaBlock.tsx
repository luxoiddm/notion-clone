'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import clsx from 'clsx';
import { KATEX_MACROS } from '../lib/katexMacros';

/**
 * Finds every not-yet-hydrated `<span class="katex-inline" data-latex="...">`
 * inside `container` (inserted by `wrapInlineFormulas()` in
 * `pasteToBlocks.ts`) and replaces its fallback "$...$" text with KaTeX's
 * rendered output, in place. Marks each one non-editable (`contentEditable
 * = 'false'`) at the same time — an editing-context detail, not something
 * baked into stored content, so the caret can't land inside a rendered
 * formula and start mangling KaTeX's own generated markup one keystroke
 * at a time. Idempotent via `data-hydrated` — safe to call on every
 * render; only touches spans it hasn't already filled in, and a
 * subsequent sanitize pass (see sanitize.ts) strips that marker itself
 * whenever `data-latex` actually changes, so an edited formula gets
 * re-rendered rather than skipped.
 *
 * Called from two places that each own their own DOM sync already:
 * `EditableBlockContent` in Editor.tsx (imperative `innerHTML` sync, for
 * the live editor) and `BlockPreview` in PageHistoryDialog.tsx (every
 * read-only viewer — history, moderation, public pages). Deliberately
 * not a React-rendered subtree — the surrounding block content is itself
 * raw HTML set via `innerHTML`/`dangerouslySetInnerHTML`, not JSX, so
 * there's no React tree here for a component to render into.
 */
export function hydrateInlineFormulas(container: HTMLElement) {
  const spans = container.querySelectorAll<HTMLElement>('span.katex-inline[data-latex]');
  spans.forEach((span) => {
    if (span.dataset.hydrated === '1') return;
    const latex = span.getAttribute('data-latex') ?? '';
    try {
      span.innerHTML = katex.renderToString(latex, { throwOnError: false, trust: false, displayMode: false, macros: KATEX_MACROS });
    } catch {
      // Leave the literal "$...$" fallback text in place — matches
      // FormulaPreview's own fallback reasoning for the block form.
      return;
    }
    span.contentEditable = 'false';
    span.dataset.hydrated = '1';
  });
}

/**
 * Renders a LaTeX string to KaTeX's own HTML/MathML output.
 * `dangerouslySetInnerHTML` here is safe despite the name: the HTML comes
 * from KaTeX itself, not from the user's raw string round-tripped through
 * the DOM — KaTeX renders its own fixed set of math markup and, with
 * `trust: false` (KaTeX's own default, kept explicit here on purpose),
 * refuses to expand the handful of commands that could otherwise embed
 * arbitrary URLs/images (`\href`, `\includegraphics`, `\url`). This is a
 * different trust boundary than `sanitizeInlineHtml()` in lib/sanitize.ts
 * (an allowlist over arbitrary user HTML) — formula content is never
 * treated as HTML anywhere else in the app, only ever passed through
 * KaTeX's own renderer.
 */
export function FormulaPreview({ latex, displayMode = true }: { latex: string; displayMode?: boolean }) {
  const result = useMemo(() => {
    try {
      return { html: katex.renderToString(latex, { throwOnError: false, trust: false, displayMode, macros: KATEX_MACROS }), error: null as string | null };
    } catch (err) {
      // throwOnError: false already makes KaTeX render its own inline
      // error message for a bad expression instead of throwing — this
      // catch is a last-resort fallback for anything unexpected outside
      // KaTeX's own parsing (it shouldn't normally trigger).
      return { html: null, error: err instanceof Error ? err.message : 'Ошибка формулы' };
    }
  }, [latex, displayMode]);

  if (result.error) {
    return <span className="text-sm text-danger">{result.error}</span>;
  }
  // eslint-disable-next-line react/no-danger
  return <div className={clsx(displayMode && 'overflow-x-auto')} dangerouslySetInnerHTML={{ __html: result.html! }} />;
}

/**
 * Edit/view for a 'formula' block inside the editor. Not built on
 * EditableBlockContent (contentEditable + execCommand) like every other
 * text block — LaTeX source is plain text, not rich inline HTML, and
 * needs its own KaTeX-rendered view rather than showing raw markup. Click
 * (or Enter/Space via keyboard) toggles into a plain `<textarea>` for
 * editing; blur or Escape commits back to view mode, mirroring the
 * pattern already used by PageCoverPicker/PageIconPicker of a dedicated
 * small component per feature rather than folding it into Editor.tsx.
 */
export function FormulaBlockContent({
  blockId,
  content,
  readOnly,
  onChange,
  onFocus,
}: {
  blockId: string;
  content: string;
  readOnly?: boolean;
  onChange: (content: string) => void;
  onFocus?: () => void;
}) {
  const [editing, setEditing] = useState(!readOnly && content.trim() === '');
  const [draft, setDraft] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keeps the draft in sync when the block's real content changes for a
  // reason other than this component's own editing (e.g. undo, a
  // collaborator's edit arriving) — same "only when not actively typing
  // here" guard as EditableBlockContent's own effect in Editor.tsx.
  useEffect(() => {
    if (!editing) setDraft(content);
  }, [content, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== content) onChange(draft);
  };

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        data-block-id={blockId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={onFocus}
        onBlur={commit}
        onKeyDown={(e) => {
          // Escape cancels the edit without saving — Enter/Shift+Enter
          // stay literal newlines, formulas like \begin{cases}...\end{cases}
          // are genuinely multi-line, unlike every other block type where
          // Enter creates a new block.
          if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(content);
            setEditing(false);
          }
        }}
        placeholder="Формула в LaTeX, например: E = mc^2"
        rows={Math.max(1, draft.split('\n').length)}
        spellCheck={false}
        className="input resize-none font-mono"
      />
    );
  }

  const isEmpty = content.trim() === '';

  return (
    <div
      data-block-id={blockId}
      tabIndex={readOnly ? undefined : 0}
      role={readOnly ? undefined : 'button'}
      onFocus={onFocus}
      onClick={() => !readOnly && setEditing(true)}
      onKeyDown={(e) => {
        if (!readOnly && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          setEditing(true);
        }
      }}
      className={clsx(
        'min-h-[2.5rem] w-full rounded-md px-3 py-2 outline-none',
        !readOnly && 'cursor-text hover:bg-surface-hover',
        isEmpty && 'text-sm text-ink-faint',
      )}
    >
      {isEmpty ? (readOnly ? null : 'Нажмите, чтобы ввести формулу...') : <FormulaPreview latex={content} />}
    </div>
  );
}
