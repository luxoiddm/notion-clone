const KEY = 'workspace:last-location';

export type LastLocation = { route: 'editor'; ownerId: string; projectId: string; pageId: string } | { route: 'chat'; chatId: string };

/** localStorage can throw — private-browsing mode in some browsers, quota exceeded, disabled entirely by the user. This is a nice-to-have convenience feature (remembering where someone was), not worth crashing the app over if it's unavailable. */
export function saveLastLocation(loc: LastLocation): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loc));
  } catch {
    // Silently skipped — see the function's doc comment above.
  }
}

export function getLastLocation(): LastLocation | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'route' in parsed &&
      ((parsed.route === 'editor' && 'ownerId' in parsed && 'projectId' in parsed && 'pageId' in parsed) ||
        (parsed.route === 'chat' && 'chatId' in parsed))
    ) {
      return parsed as LastLocation;
    }
    return null;
  } catch {
    return null;
  }
}
