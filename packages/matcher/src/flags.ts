import { MAX_SUSPECTS, type Counter, type CountryCounts, type Report } from '@tempo-match/catalog';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FLAGS_PER_PREFIX_HOUR = 10;
const PREFIXES_FOR_SUSPECT = 3;
const MAX_ENTRIES = 10_000;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const HEXTET = /^[0-9a-f]{1,4}$/i;
const IPV6_GROUPS = 8;
const IPV6_PREFIX_GROUPS = 3;

/** Dead-song flags by IP prefix, in memory only, so a restart forgets them. */
export interface Flags {
  /** Counts a flag unless the prefix already sent its hourly share. */
  flag(spotifyTrackId: string, prefix: string, now: number): void;
  /** Ids flagged by enough different prefixes in the last day, most flagged first. */
  suspects(now: number): string[];
}

export function flags(): Flags {
  const byPrefix = new Map<string, number[]>();
  const byId = new Map<string, Map<string, number>>();

  function touch<K, V>(map: Map<K, V>, key: K, value: V) {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_ENTRIES) {
      map.delete(map.keys().next().value!);
    }
  }

  return {
    flag(id, prefix, now) {
      const recent = (byPrefix.get(prefix) ?? []).filter((time) => time > now - HOUR_MS);
      if (recent.length >= FLAGS_PER_PREFIX_HOUR) {
        return;
      }
      touch(byPrefix, prefix, [...recent, now]);
      const prefixes = byId.get(id) ?? new Map<string, number>();
      prefixes.set(prefix, now);
      touch(byId, id, prefixes);
    },
    suspects(now) {
      const counted = [...byId].map(([id, prefixes]) => {
        for (const [prefix, time] of prefixes) {
          if (time <= now - DAY_MS) {
            prefixes.delete(prefix);
          }
        }
        return { id, prefixes: prefixes.size };
      });
      return counted
        .filter(({ prefixes }) => prefixes >= PREFIXES_FOR_SUSPECT)
        .sort((a, b) => b.prefixes - a.prefixes)
        .slice(0, MAX_SUSPECTS)
        .map(({ id }) => id);
    },
  };
}

/** The /24 of an IPv4 address or the /48 of an IPv6 one, or null for anything else. */
export function ipPrefix(ip: string): string | null {
  const address = IPV4_MAPPED.exec(ip)?.[1] ?? ip;
  const v4 = IPV4.exec(address);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    return octets.every((o) => o <= 255) ? octets.slice(0, 3).join('.') : null;
  }

  const halves = address.split('::');
  if (halves.length > 2) {
    return null;
  }
  const [head, tail] = halves.map((half) => (half ? half.split(':') : []));
  const missing = IPV6_GROUPS - head.length - (tail?.length ?? 0);
  if ((tail === undefined && missing !== 0) || (tail !== undefined && missing < 1)) {
    return null;
  }
  const groups = [...head, ...Array(tail === undefined ? 0 : missing).fill('0'), ...(tail ?? [])];
  if (!groups.every((group) => HEXTET.test(group))) {
    return null;
  }
  return groups.slice(0, IPV6_PREFIX_GROUPS).map((group) => parseInt(group, 16).toString(16)).join(':');
}

/** Per-country request counts since the last take. */
export interface Counters {
  add(country: string, counter: Counter): void;
  take(): Record<string, CountryCounts>;
}

export function counters(): Counters {
  let counts = new Map<string, CountryCounts>();
  return {
    add(country, counter) {
      const entry = counts.get(country) ?? { served: 0, fallback: 0, empty: 0, dead: 0 };
      entry[counter]++;
      counts.set(country, entry);
    },
    take() {
      const taken = Object.fromEntries(counts);
      counts = new Map();
      return taken;
    },
  };
}

export interface Reporter {
  /** Sends the current suspects and the counts since the last push; never overlaps or retries. */
  push(): Promise<void>;
}

const PUSH_TIMEOUT_MS = 2_000;

export function reporter(
  url: string,
  market: string,
  flagged: Flags,
  counted: Counters,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Reporter {
  let pushing = false;
  let failing = false;
  return {
    async push() {
      if (pushing) {
        return;
      }
      pushing = true;
      const report: Report = {
        suspects: flagged.suspects(now()).map((spotifyTrackId) => ({ market, spotifyTrackId })),
        countries: counted.take(),
      };
      try {
        const res = await fetchFn(new URL('/reports', url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        failing = false;
      } catch (err) {
        if (!failing) {
          console.error(`Report to the collector failed, dropping it: ${(err as Error).message}`);
        }
        failing = true;
      } finally {
        pushing = false;
      }
    },
  };
}
