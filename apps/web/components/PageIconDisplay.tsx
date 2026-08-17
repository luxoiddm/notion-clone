import { isTileIconUrl } from '../lib/pageIcons';

/**
 * Renders a page's icon field, whichever kind it is (see
 * lib/pageIcons.ts's isTileIconUrl doc comment). `size` controls the
 * rendered dimensions when it's a tile image — irrelevant for a plain
 * emoji, which sizes itself from the surrounding text's font-size like
 * any other character.
 */
export function PageIconDisplay({
  icon,
  size = 16,
  fallback,
  className,
}: {
  icon: string | null;
  size?: number;
  fallback?: React.ReactNode;
  className?: string;
}) {
  if (!icon) return <>{fallback ?? null}</>;

  if (isTileIconUrl(icon)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={icon}
        alt=""
        width={size}
        height={size}
        className={className ?? 'inline-block shrink-0 rounded-sm object-cover'}
        style={{ width: size, height: size }}
      />
    );
  }

  return <span className={className}>{icon}</span>;
}
