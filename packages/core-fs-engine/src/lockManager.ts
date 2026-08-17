/**
 * In-process async lock keyed by absolute path. Guarantees that concurrent
 * writes/reads-then-writes to the same file inside a single server process
 * never interleave (prevents lost-update races on meta.json / content files).
 *
 * For a multi-process deployment, swap the `run` implementation for
 * `proper-lockfile` (already a declared dependency) which takes an OS-level
 * advisory lock on disk — the public API below would not need to change.
 */
class LockManager {
  private queues = new Map<string, Promise<unknown>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const chained = previous.then(() => gate);
    this.queues.set(key, chained);

    // Wait our turn.
    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(key) === chained) {
        this.queues.delete(key);
      }
    }
  }
}

export const lockManager = new LockManager();
