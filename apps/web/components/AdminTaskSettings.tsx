'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';
import { tasksApi, type TaskVisibility } from '../lib/api';

const OPTIONS: { id: TaskVisibility; title: string; text: string }[] = [
  {
    id: 'own',
    title: 'Только свои задачи',
    text: 'Сотрудник видит проект, если участвует хотя бы в одной его задаче, а внутри — только задачи, где он постановщик, ответственный, соисполнитель или наблюдатель. Чужая задача, которую ждёт его задача, видна закрытой карточкой: номер, статус и срок.',
  },
  {
    id: 'project',
    title: 'Все задачи своих проектов',
    text: 'Участники проекта видят все его задачи, обсуждения и вложения.',
  },
];

/** Админка → «Задачи»: кто какие задачи видит. Администраторы, тимлиды и создатель проекта видят всё в любом режиме. */
export function AdminTaskSettings({ onNotify }: { onNotify: (msg: string, kind?: 'success' | 'error') => void }) {
  const [value, setValue] = useState<TaskVisibility | null>(null);
  const [saving, setSaving] = useState<TaskVisibility | null>(null);

  useEffect(() => {
    tasksApi
      .settings()
      .then((s) => setValue(s.visibility))
      .catch(() => onNotify('Не удалось загрузить настройки задач', 'error'));
  }, [onNotify]);

  const pick = async (v: TaskVisibility) => {
    if (v === value || saving) return;
    setSaving(v);
    try {
      setValue((await tasksApi.updateSettings({ visibility: v })).visibility);
      onNotify('Сохранено', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Не удалось сохранить', 'error');
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="card flex max-w-2xl flex-col gap-4 p-5">
      <div>
        <h2 className="text-[15px] font-semibold">Видимость задач</h2>
        <p className="mt-1 text-sm text-ink-muted">Администраторы, тимлиды и создатель проекта видят все задачи в любом режиме.</p>
      </div>
      <div role="radiogroup" aria-label="Видимость задач" className="flex flex-col gap-2">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            disabled={value === null}
            onClick={() => void pick(o.id)}
            className={clsx(
              'flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition',
              value === o.id ? 'border-accent bg-accent-soft/60' : 'border-line/10 hover:bg-surface-hover',
            )}
          >
            <span className={clsx('mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2', value === o.id ? 'border-accent' : 'border-line/30')}>
              {value === o.id && <span className="h-2 w-2 rounded-full bg-accent" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                {o.title}
                {o.id === 'own' && <span className="rounded bg-surface-hover px-1.5 text-[11px] font-normal text-ink-muted">по умолчанию</span>}
                {saving === o.id && <Loader2 size={13} className="animate-spin" />}
              </span>
              <span className="mt-0.5 block text-[13px] text-ink-muted">{o.text}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
