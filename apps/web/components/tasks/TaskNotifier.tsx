'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SquareCheckBig, X } from 'lucide-react';
import { getSocket } from '../../lib/socket';
import { claimOnce, playSound } from '../../lib/sounds';

interface TaskNotify {
  kind: string;
  projectId: string;
  taskId: string;
  key: string;
  title: string;
  byId: string | null;
  byName: string | null;
  text?: string;
}

function describe(n: TaskNotify): { head: string; body: string } {
  const by = n.byName ?? 'Коллега';
  const task = `${n.key} «${n.title}»`;
  const quote = n.text ? `: «${n.text}»` : '';
  switch (n.kind) {
    case 'assigned':
      return { head: `${by} поручил(а) вам задачу`, body: task };
    case 'co-assigned':
      return { head: `${by} добавил(а) вас соисполнителем`, body: task };
    case 'accepted':
      return { head: `${by} принял(а) поручение`, body: task };
    case 'declined':
      return { head: `${by} отклонил(а) поручение`, body: `${task}${quote}` };
    case 'submitted':
      return { head: `${by} сдал(а) работу на проверку`, body: task };
    case 'approved':
      return { head: `${by} принял(а) вашу работу`, body: task };
    case 'returned':
      return { head: `${by} вернул(а) на доработку`, body: `${task}${quote}` };
    case 'unblocked':
      return { head: 'Можно начинать', body: `${task} — ${n.text ?? 'всё, чего она ждала, готово'}` };
    case 'mention':
      return { head: `${by} упомянул(а) вас`, body: `${n.key}: ${n.text ?? ''}` };
    case 'comment':
      return { head: `${by} в ${n.key}`, body: n.text ?? '' };
    case 'due-changed':
      return { head: `${by}: изменён срок`, body: `${task}${quote}` };
    case 'deadline-soon':
      return { head: 'Дедлайн через 2 дня', body: task };
    case 'deadline-today':
      return { head: 'Сегодня дедлайн', body: task };
    case 'overdue':
      return { head: 'Дедлайн пропущен', body: task };
    default:
      return { head: 'Задачи', body: task };
  }
}

/**
 * Уведомления раздела «Задачи» на любой странице: звук нового сообщения
 * и карточка в углу (нажатие открывает задачу). Сервер шлёт
 * 'task:notify' в личную комнату адресата.
 */
export function TaskNotifier({ accessToken, currentUserId }: { accessToken: string | null; currentUserId: string | null }) {
  const router = useRouter();
  const [items, setItems] = useState<(TaskNotify & { id: string })[]>([]);

  useEffect(() => {
    if (!accessToken || !currentUserId) return;
    const socket = getSocket(accessToken);
    const onNotify = (n: TaskNotify) => {
      if (n.byId === currentUserId) return;
      const id = `${n.taskId}:${n.kind}:${Date.now()}`;
      setItems((prev) => [...prev.slice(-2), { ...n, id }]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), 7000);
      if (claimOnce(`task:${n.taskId}:${n.kind}:${Math.floor(Date.now() / 5000)}`)) playSound('message');
    };
    socket.on('task:notify', onNotify);
    return () => {
      socket.off('task:notify', onNotify);
    };
  }, [accessToken, currentUserId]);

  if (!items.length) return null;
  return (
    <div className="pointer-events-none fixed right-3 top-[max(12px,env(safe-area-inset-top))] z-[70] flex w-[min(360px,calc(100vw-24px))] flex-col gap-2">
      {items.map((n) => {
        const { head, body } = describe(n);
        return (
          <div key={n.id} className="pointer-events-auto flex animate-popIn items-start gap-3 rounded-xl bg-surface-raised p-3 shadow-dialog">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <SquareCheckBig size={16} />
            </span>
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => {
                setItems((prev) => prev.filter((x) => x.id !== n.id));
                router.push(`/tasks?project=${n.projectId}&task=${n.taskId}`);
              }}
            >
              <span className="block text-[13px] font-semibold text-ink">{head}</span>
              <span className="line-clamp-2 block text-[13px] text-ink-muted">{body}</span>
            </button>
            <button type="button" className="btn-icon-sm" aria-label="Закрыть" onClick={() => setItems((prev) => prev.filter((x) => x.id !== n.id))}>
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
