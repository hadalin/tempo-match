import { DatabaseSync } from 'node:sqlite';
import { DAY_MS } from './cache.ts';

// Spotify Developer Terms IV.3: no databases of Spotify Content "other than as strictly
// necessary to operate your SDA", and "Do not store Spotify Content indefinitely". So rows hold
// only Spotify track ids next to our own data, and every row expires.
const FOUND_TTL_MS = 30 * DAY_MS;
const MISS_TTL_MS = 14 * DAY_MS;
const MAX_STORED_SONGS = 50_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS songs (
    market TEXT NOT NULL,
    identity TEXT NOT NULL,
    outcome TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    spotify_track_id TEXT,
    tempo REAL,
    speechiness REAL,
    rejection TEXT,
    stored_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (market, identity)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS songs_by_age ON songs (stored_at);
  CREATE INDEX IF NOT EXISTS songs_by_expiry ON songs (expires_at);
`;
const COLUMNS = `outcome, title, artist, spotify_track_id AS spotifyTrackId, tempo, speechiness,
  rejection`;

export type Outcome = 'found' | 'rejected' | 'not-found';
export type Rejection = 'tempo' | 'spoken';

/** How a provider song resolved on Spotify, with the provider's title and artist. */
export interface Resolution {
  outcome: Outcome;
  title: string;
  artist: string;
  spotifyTrackId: string | null;
  tempo: number | null;
  speechiness: number | null;
  rejection: Rejection | null;
}

/** Resolved songs per market and provider identity, until each entry expires. */
export interface SongStore {
  get(market: string, identity: string): Resolution | undefined;
  put(market: string, identity: string, resolution: Resolution): void;
  /** Up to `limit` random found songs in the market. */
  sample(market: string, limit: number): Resolution[];
}

interface Entry {
  market: string;
  resolution: Resolution;
  expiresAt: number;
}

export function memorySongStore(
  now: () => number = Date.now,
  maxSongs = MAX_STORED_SONGS,
): SongStore {
  const entries = new Map<string, Entry>();

  return {
    get(market, identity) {
      const entry = entries.get(JSON.stringify([market, identity]));
      return entry && now() < entry.expiresAt ? entry.resolution : undefined;
    },
    put(market, identity, resolution) {
      const key = JSON.stringify([market, identity]);
      entries.delete(key);
      if (entries.size >= maxSongs) {
        entries.delete(entries.keys().next().value!);
      }
      entries.set(key, { market, resolution, expiresAt: now() + ttlOf(resolution) });
    },
    sample(market, limit) {
      const found = [...entries.values()].filter(
        (entry) =>
          now() < entry.expiresAt && entry.market === market && entry.resolution.outcome === 'found',
      );
      return found
        .map((entry) => ({ entry, order: Math.random() }))
        .sort((a, b) => a.order - b.order)
        .slice(0, limit)
        .map(({ entry }) => entry.resolution);
    },
  };
}

/**
 * A SQLite song store at `path`. When the file cannot be opened, logs once and keeps songs in
 * memory instead; a later database error is logged once and treated as a miss.
 */
export function openSongStore(
  path: string,
  now: () => number = Date.now,
  maxSongs = MAX_STORED_SONGS,
): SongStore {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
    db.exec(SCHEMA);
  } catch (err) {
    console.error(`Cannot open the song store at ${path}, keeping songs in memory:`, err);
    return memorySongStore(now, maxSongs);
  }

  const select = db.prepare(
    `SELECT ${COLUMNS} FROM songs WHERE market = ? AND identity = ? AND expires_at > ?`,
  );
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO songs (market, identity, outcome, title, artist, spotify_track_id,
      tempo, speechiness, rejection, stored_at, expires_at)
    VALUES (:market, :identity, :outcome, :title, :artist, :spotifyTrackId, :tempo, :speechiness,
      :rejection, :storedAt, :expiresAt)
  `);
  const prune = db.prepare('DELETE FROM songs WHERE expires_at <= ?');
  const evict = db.prepare(`
    DELETE FROM songs WHERE rowid IN (
      SELECT rowid FROM songs ORDER BY stored_at, rowid
      LIMIT max(0, (SELECT count(*) FROM songs) - ?)
    )
  `);
  const sample = db.prepare(`
    SELECT ${COLUMNS} FROM songs WHERE market = ? AND outcome = 'found' AND expires_at > ?
    ORDER BY random() LIMIT ?
  `);

  let failed = false;
  function attempt<T>(operation: () => T, fallback: T): T {
    try {
      return operation();
    } catch (err) {
      if (!failed) {
        failed = true;
        console.error(`The song store at ${path} failed, treating it as empty:`, err);
      }
      return fallback;
    }
  }

  return {
    get: (market, identity) =>
      attempt(() => {
        const row = select.get(market, identity, now());
        return row && ({ ...row } as unknown as Resolution);
      }, undefined),
    put: (market, identity, resolution) =>
      attempt(() => {
        const storedAt = now();
        const expiresAt = storedAt + ttlOf(resolution);
        upsert.run({ market, identity, ...resolution, storedAt, expiresAt });
        prune.run(storedAt);
        evict.run(maxSongs);
      }, undefined),
    sample: (market, limit) =>
      attempt(() => {
        const rows = sample.all(market, now(), limit);
        return rows.map((row) => ({ ...row }) as unknown as Resolution);
      }, []),
  };
}

function ttlOf(resolution: Resolution): number {
  return resolution.outcome === 'found' ? FOUND_TTL_MS : MISS_TTL_MS;
}
