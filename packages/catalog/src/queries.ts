import type { DatabaseSync } from 'node:sqlite';
import { PICK_LIFETIME_MS } from './picks.ts';

export interface ServedSong {
  title: string;
  artist: string;
  bpm: number;
  spotifyTrackId: string;
}

export interface PickSummary {
  picks: number;
  oldestLookedUpAt: number | null;
}

/** The reads of the public service. `skip` holds up to two track ids never to serve. */
export interface MatcherQueries {
  /** A random servable pick at `bpm`, chosen from a point `random` in [0, 1) of the shuffle order. */
  songAt(market: string, bpm: number, skip: string[], now: number, random: number): ServedSong | null;
  /** A random servable pick at any BPM except `excludeBpm`. */
  lucky(market: string, excludeBpm: number, skip: string[], now: number, random: number): ServedSong | null;
  isPick(market: string, spotifyTrackId: string, now: number): boolean;
  summary(market: string, now: number): PickSummary;
}

const SERVED_COLUMNS = 'SELECT s.title, s.artist, p.bpm, p.spotify_track_id AS spotifyTrackId';
const SERVABLE = `p.looked_up_at > :expired AND p.spotify_track_id NOT IN (:skip1, :skip2)
  AND s.status = 'ok'`;
// A track id is 22 characters, so this never matches one.
const NO_SKIP = '';

export function matcherQueries(db: DatabaseSync): MatcherQueries {
  const songAt = db.prepare(`
    ${SERVED_COLUMNS} FROM picks p JOIN songs s ON s.identity = p.identity AND s.bpm = p.bpm
    WHERE p.market = :market AND p.bpm = :bpm AND p.shuffle >= :from AND ${SERVABLE}
    ORDER BY p.shuffle LIMIT 1
  `);
  const lucky = db.prepare(`
    ${SERVED_COLUMNS} FROM picks p JOIN songs s ON s.identity = p.identity AND s.bpm = p.bpm
    WHERE p.market = :market AND p.shuffle >= :from AND p.bpm <> :exclude AND ${SERVABLE}
    ORDER BY p.shuffle LIMIT 1
  `);
  const isPick = db.prepare(`
    SELECT 1 FROM picks WHERE spotify_track_id = ? AND market = ? AND looked_up_at > ? LIMIT 1
  `);
  const summary = db.prepare(`
    SELECT count(*) AS picks, min(looked_up_at) AS oldestLookedUpAt FROM picks
    WHERE market = ? AND looked_up_at > ?
  `);

  function skipParams(skip: string[], now: number) {
    return { skip1: skip[0] ?? NO_SKIP, skip2: skip[1] ?? NO_SKIP, expired: now - PICK_LIFETIME_MS };
  }

  function fromPoint(random: number, read: (from: number) => unknown): ServedSong | null {
    const song = read(random) ?? read(0);
    return song ? { ...(song as ServedSong) } : null;
  }

  return {
    songAt(market, bpm, skip, now, random) {
      const params = { market, bpm, ...skipParams(skip, now) };
      return fromPoint(random, (from) => songAt.get({ ...params, from }));
    },
    lucky(market, excludeBpm, skip, now, random) {
      const params = { market, exclude: excludeBpm, ...skipParams(skip, now) };
      return fromPoint(random, (from) => lucky.get({ ...params, from }));
    },
    isPick: (market, id, now) => isPick.get(id, market, now - PICK_LIFETIME_MS) !== undefined,
    summary(market, now) {
      const row = summary.get(market, now - PICK_LIFETIME_MS) as unknown as PickSummary;
      return { picks: row.picks, oldestLookedUpAt: row.oldestLookedUpAt };
    },
  };
}
