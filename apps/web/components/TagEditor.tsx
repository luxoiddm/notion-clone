'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

export function TagEditor({
  tags,
  onChange,
  readOnly,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState('');

  const addTag = () => {
    const trimmed = draft.trim();
    setDraft('');
    if (!trimmed || tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  if (readOnly && tags.length === 0) return null;

  return (
    <div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 rounded-full border border-line/10 bg-surface px-2 py-0.5 text-xs text-ink-muted"
            >
              {tag}
              {!readOnly && (
                <button type="button" onClick={() => removeTag(tag)} title="Убрать тег" className="text-ink-faint hover:text-red-500">
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {!readOnly && (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
          placeholder="Добавить тег..."
          className={`w-full rounded-md border border-line/10 bg-surface px-2 py-1 text-xs focus:border-accent focus:outline-none ${
            tags.length > 0 ? 'mt-1.5' : ''
          }`}
        />
      )}
    </div>
  );
}
