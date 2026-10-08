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
              className="flex h-6 items-center gap-1 rounded-full bg-accent-soft px-2.5 text-xs font-medium text-accent-ink"
            >
              {tag}
              {!readOnly && (
                <button type="button" onClick={() => removeTag(tag)} title="Убрать тег" className="text-ink-faint hover:text-danger">
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
          className={`input h-8 text-xs ${
            tags.length > 0 ? 'mt-1.5' : ''
          }`}
        />
      )}
    </div>
  );
}
