import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;
export const MIN_BPM = 40;
export const MAX_BPM = 220;
// node:sqlite cannot read a larger integer as a number; this is also the largest JavaScript date.
export const UNTIL_UNBLOCKED = 8_640_000_000_000_000;
export const SERVICES = ['spotify', 'reccobeats', 'getsongbpm', 'deezer'] as const;
export type Service = (typeof SERVICES)[number];

const WRITER_BUSY_TIMEOUT_MS = 5_000;
const READER_BUSY_TIMEOUT_MS = 50;

// Spotify Developer Terms IV: no databases of Spotify Content "other than as strictly necessary to
// operate your SDA". So picks is the only table with a Spotify id, and misses keep none.
const SCHEMA = `
CREATE TABLE songs (
  identity TEXT NOT NULL,
  bpm INTEGER NOT NULL CHECK (bpm BETWEEN ${MIN_BPM} AND ${MAX_BPM}),
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  isrc TEXT,
  duration_s INTEGER,
  popularity REAL NOT NULL CHECK (popularity BETWEEN 0 AND 1),
  sources INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'short')),
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (identity, bpm)
) STRICT, WITHOUT ROWID;
CREATE INDEX songs_by_bpm ON songs (bpm, popularity) WHERE status = 'ok';
CREATE INDEX songs_by_seen ON songs (seen_at);

CREATE TABLE crawl_state (
  source TEXT NOT NULL,
  bpm INTEGER NOT NULL,
  seed TEXT NOT NULL,
  next_index INTEGER NOT NULL,
  done_at INTEGER,
  PRIMARY KEY (source, bpm, seed)
) STRICT, WITHOUT ROWID;

CREATE TABLE picks (
  market TEXT NOT NULL,
  bpm INTEGER NOT NULL,
  identity TEXT NOT NULL,
  spotify_track_id TEXT NOT NULL CHECK (length(spotify_track_id) = 22),
  looked_up_at INTEGER NOT NULL,
  tempo REAL CHECK (tempo IS NULL OR abs(tempo - bpm) <= 3),
  speechiness REAL CHECK (speechiness IS NULL OR speechiness < 0.66),
  features_at INTEGER,
  shuffle REAL NOT NULL,
  PRIMARY KEY (market, bpm, spotify_track_id),
  FOREIGN KEY (identity, bpm) REFERENCES songs (identity, bpm) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX picks_by_identity ON picks (market, identity);
CREATE INDEX picks_by_track ON picks (spotify_track_id, market, looked_up_at);
CREATE INDEX picks_by_bpm_shuffle ON picks (market, bpm, shuffle);
CREATE INDEX picks_by_shuffle ON picks (market, shuffle);
CREATE INDEX picks_by_age ON picks (looked_up_at);
CREATE INDEX picks_unchecked ON picks (spotify_track_id) WHERE features_at IS NULL;
CREATE TRIGGER picks_id_fixed BEFORE UPDATE OF spotify_track_id ON picks
BEGIN SELECT RAISE(ABORT, 'spotify_track_id is never updated'); END;

CREATE TABLE misses (
  market TEXT NOT NULL,
  identity TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('not-found', 'spoken', 'tempo', 'duplicate')),
  looked_up_at INTEGER NOT NULL,
  PRIMARY KEY (market, identity)
) STRICT, WITHOUT ROWID;
CREATE INDEX misses_by_age ON misses (looked_up_at);
CREATE INDEX misses_by_reason ON misses (market, reason);

-- A duplicate miss stands for "another song already serves this recording at a listing of this
-- song". Once a pick leaves a (market, bpm), or a listing of the song goes, that may no longer
-- hold, so the miss goes and the fill looks the song up again.
CREATE TRIGGER picks_freed AFTER DELETE ON picks
BEGIN
  DELETE FROM misses WHERE market = OLD.market AND reason = 'duplicate' AND EXISTS (
    SELECT 1 FROM songs
    WHERE songs.identity = misses.identity AND songs.bpm = OLD.bpm AND songs.status = 'ok'
  );
END;
CREATE TRIGGER songs_closed AFTER UPDATE OF status ON songs WHEN NEW.status <> 'ok'
BEGIN DELETE FROM misses WHERE identity = OLD.identity AND reason = 'duplicate'; END;
CREATE TRIGGER songs_deleted AFTER DELETE ON songs
BEGIN DELETE FROM misses WHERE identity = OLD.identity AND reason = 'duplicate'; END;

CREATE TABLE upstream (
  service TEXT PRIMARY KEY CHECK (service IN (${SERVICES.map((s) => `'${s}'`).join(', ')})),
  day INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  recheck_calls INTEGER NOT NULL,
  banned_until INTEGER NOT NULL,
  ban_reason TEXT,
  held_until INTEGER NOT NULL,
  hold_reason TEXT,
  failures INTEGER NOT NULL
) STRICT;
INSERT INTO upstream (service, day, calls, recheck_calls, banned_until, held_until, failures)
VALUES ${SERVICES.map((s) => `('${s}', 0, 0, 0, 0, 0, 0)`).join(', ')};

PRAGMA user_version = ${SCHEMA_VERSION};
`;

export class SchemaVersionError extends Error {
  constructor(path: string, found: number) {
    super(`${path} has schema version ${found}, expected ${SCHEMA_VERSION}`);
    this.name = 'SchemaVersionError';
  }
}

/** Opens the catalog for writing, creating the schema in a new file. */
export function openWriter(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: WRITER_BUSY_TIMEOUT_MS });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');

  const version = schemaVersion(db);
  if (version === 0) {
    transaction(db, () => db.exec(SCHEMA));
    return db;
  }
  if (version !== SCHEMA_VERSION) {
    db.close();
    throw new SchemaVersionError(path, version);
  }
  // Catalogs from before per-country counts were dropped still hold this table; dropping it in
  // place keeps the version, so either release reads the file and it is never rebuilt.
  db.exec('DROP TABLE IF EXISTS country_daily');
  return db;
}

/** Opens an existing catalog read-only; throws SchemaVersionError until the writer created it. */
export function openReader(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true, timeout: READER_BUSY_TIMEOUT_MS });
  const version = schemaVersion(db);
  if (version !== SCHEMA_VERSION) {
    db.close();
    throw new SchemaVersionError(path, version);
  }
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
