export const DAY_MS = 24 * 60 * 60 * 1000;

interface Entry<V> {
  value: Promise<V>;
  expiresAt: number;
}

export type Cached<V> = (key: string, load: () => Promise<V>) => Promise<V>;

/**
 * Shares one load per key until `ttlMs` after it started. Rejected loads are dropped so the next
 * call retries. Beyond `maxEntries`, the oldest entry is evicted.
 */
export function ttlCache<V>(ttlMs: number, maxEntries: number, now: () => number): Cached<V> {
  const entries = new Map<string, Entry<V>>();

  return (key, load) => {
    const hit = entries.get(key);
    if (hit && now() < hit.expiresAt) {
      return hit.value;
    }

    entries.delete(key);
    if (entries.size >= maxEntries) {
      entries.delete(entries.keys().next().value!);
    }

    const value = load();
    entries.set(key, { value, expiresAt: now() + ttlMs });
    value.catch(() => {
      if (entries.get(key)?.value === value) {
        entries.delete(key);
      }
    });
    return value;
  };
}
