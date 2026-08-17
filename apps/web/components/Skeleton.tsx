import clsx from 'clsx';

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={clsx('skeleton animate-shimmer rounded-md', className)} style={style} />;
}

export function SidebarSkeleton() {
  return (
    <div className="space-y-2 px-3 py-2">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} className="h-6 w-full" style={{ animationDelay: `${i * 60}ms` } as React.CSSProperties} />
      ))}
    </div>
  );
}

export function EditorSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-16 py-16">
      <Skeleton className="mb-6 h-10 w-2/3" />
      <div className="space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="mt-6 h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}
