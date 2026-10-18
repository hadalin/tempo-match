import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { transaction } from './schema.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const PICK_LIFETIME_MS = 180 * DAY_MS;
export const REFRESH_AFTER_MS = PICK_LIFETIME_MS - 7 * DAY_MS;
export const MISS_LIFETIME_MS = 14 * DAY_MS;
export const UNSEEN_LISTING_MS = 90 * DAY_MS;
export const COUNTRY_DAYS = 30;
export const TEMPO_TOLERANCE_BPM = 3;
// Spotify documents tracks at or above this speechiness as probably all spoken words.
export const SPOKEN_WORD_SPEECHINESS = 0.66;
export const MIN_SONG_SECONDS = 90;

export const SOURCE_GETSONGBPM = 1;
export const SOURCE_DEEZER = 2;

export interface Listing {
  identity: string;
  bpm: number;
  title: string;
  artist: string;
  isrc?: string;
  durationS?: number;
  popularity: number;
  source: number;
}

export interface Features {
  tempo: number | null;
  speechiness: number | null;
}

export type MissReason = 'not-found' | 'spoken' | 'tempo' | 'duplicate';

interface StoredFeatures {
  tempo: number | null;
  speechiness: number | null;
  features_at: number | null;
}

interface Holder {
  market: string;
  identity: string;
  looked_up_at: number;
}

const FITS = `(:tempo IS NULL OR abs(:tempo - s.bpm) <= ${TEMPO_TOLERANCE_BPM})`;
const SHUFFLE = '(random() / 18446744073709551616.0 + 0.5)';
const MERGED_DURATION =
  'coalesce(max(songs.duration_s, excluded.duration_s), songs.duration_s, excluded.duration_s)';

/**
 * Every write of a provider listing, a Spotify lookup or a ReccoBeats result. Each call is one
 * transaction, and after it every `ok` listing of a looked-up song that its recording fits holds
 * a pick, unless another song already serves that recording there.
 */
export interface Transitions {
  upsertListings(listings: Listing[], now: number): void;
  /** A Spotify lookup in `market`: the playable track id, or null when nothing plays. */
  applyLookup(market: string, identity: string, spotifyTrackId: string | null, now: number): void;
  /** A ReccoBeats answer for a track id across every market; null when it has no data. */
  applyFeatures(spotifyTrackId: string, features: Features | null, now: number): void;
  /**
   * Deletes expired picks and misses, picks of other markets and listings no pass has seen, then
   * places each recording at the listings of its song that another song's pick no longer holds.
   */
  sweep(market: string, now: number): void;
}

export function transitions(db: DatabaseSync): Transitions {
  const listingStatus = db.prepare('SELECT status FROM songs WHERE identity = ? AND bpm = ?');
  const upsertListing = db.prepare(`
    INSERT INTO songs (identity, bpm, title, artist, isrc, duration_s, popularity, sources, status, seen_at)
    VALUES (:identity, :bpm, :title, :artist, :isrc, :durationS, :popularity, :source, :status, :now)
    ON CONFLICT (identity, bpm) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      isrc = coalesce(songs.isrc, excluded.isrc),
      duration_s = ${MERGED_DURATION},
      popularity = excluded.popularity,
      sources = songs.sources | excluded.sources,
      status = CASE WHEN ${MERGED_DURATION} < ${MIN_SONG_SECONDS} THEN 'short' ELSE 'ok' END,
      seen_at = excluded.seen_at
  `);
  const clearListingMisses = db.prepare(
    "DELETE FROM misses WHERE identity = ? AND reason IN ('tempo', 'duplicate')",
  );
  const placeAtNewListing = db.prepare(`
    INSERT INTO picks (market, bpm, identity, spotify_track_id, looked_up_at, tempo, speechiness, features_at, shuffle)
    SELECT market, :bpm, identity, spotify_track_id, looked_up_at, tempo, speechiness, features_at, ${SHUFFLE}
    FROM picks
    WHERE identity = :identity AND (tempo IS NULL OR abs(tempo - :bpm) <= ${TEMPO_TOLERANCE_BPM})
    GROUP BY market
    ON CONFLICT DO NOTHING
  `);
  const deleteListingPicks = db.prepare('DELETE FROM picks WHERE identity = ? AND bpm = ?');

  const deleteSongPicks = db.prepare('DELETE FROM picks WHERE market = ? AND identity = ?');
  const deleteMiss = db.prepare('DELETE FROM misses WHERE market = ? AND identity = ?');
  const putMiss = db.prepare(`
    INSERT INTO misses (market, identity, reason, looked_up_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (market, identity) DO UPDATE SET reason = excluded.reason, looked_up_at = excluded.looked_up_at
  `);
  const checkedFeatures = db.prepare(`
    SELECT tempo, speechiness, features_at FROM picks
    WHERE spotify_track_id = ? AND features_at IS NOT NULL LIMIT 1
  `);
  const placeAtListings = db.prepare(`
    INSERT INTO picks (market, bpm, identity, spotify_track_id, looked_up_at, tempo, speechiness, features_at, shuffle)
    SELECT :market, s.bpm, s.identity, :id, :lookedUpAt, :tempo, :speechiness, :featuresAt, ${SHUFFLE}
    FROM songs s WHERE s.identity = :identity AND s.status = 'ok' AND ${FITS}
    ON CONFLICT DO NOTHING
  `);
  const hasPicks = db.prepare('SELECT 1 FROM picks WHERE market = ? AND identity = ? LIMIT 1');
  const servedByAnother = db.prepare(`
    SELECT 1 FROM songs s JOIN picks p ON p.market = :market AND p.bpm = s.bpm AND p.spotify_track_id = :id
    WHERE s.identity = :identity AND s.status = 'ok' AND ${FITS} LIMIT 1
  `);
  const anyListingFits = db.prepare(
    `SELECT 1 FROM songs s WHERE s.identity = :identity AND s.status = 'ok' AND ${FITS} LIMIT 1`,
  );

  const markChecked = db.prepare('UPDATE picks SET features_at = ? WHERE spotify_track_id = ?');
  const holders = db.prepare(`
    SELECT market, identity, max(looked_up_at) AS looked_up_at FROM picks
    WHERE spotify_track_id = ? GROUP BY market, identity
  `);
  const deleteTrack = db.prepare('DELETE FROM picks WHERE spotify_track_id = ?');
  const deleteMisfits = db.prepare(
    `DELETE FROM picks WHERE spotify_track_id = ? AND abs(? - bpm) > ${TEMPO_TOLERANCE_BPM}`,
  );
  const setFeatures = db.prepare(
    'UPDATE picks SET tempo = ?, speechiness = ?, features_at = ? WHERE spotify_track_id = ?',
  );

  const sweeps: [StatementSync, (market: string, now: number) => (string | number)[]][] = [
    [db.prepare('DELETE FROM picks WHERE looked_up_at <= ?'), (_, now) => [now - PICK_LIFETIME_MS]],
    [db.prepare('DELETE FROM picks WHERE market <> ?'), (market) => [market]],
    [db.prepare('DELETE FROM misses WHERE looked_up_at <= ?'), (_, now) => [now - MISS_LIFETIME_MS]],
    [db.prepare('DELETE FROM misses WHERE market <> ?'), (market) => [market]],
    [db.prepare('DELETE FROM songs WHERE seen_at <= ?'), (_, now) => [now - UNSEEN_LISTING_MS]],
    [db.prepare('DELETE FROM country_daily WHERE day <= ?'), (_, now) => [utcDay(now) - COUNTRY_DAYS]],
    [db.prepare(`
      INSERT INTO picks (market, bpm, identity, spotify_track_id, looked_up_at, tempo, speechiness, features_at, shuffle)
      SELECT p.market, s.bpm, s.identity, p.spotify_track_id, p.looked_up_at, p.tempo, p.speechiness, p.features_at, ${SHUFFLE}
      FROM (SELECT DISTINCT market, identity, spotify_track_id, looked_up_at, tempo, speechiness, features_at FROM picks) p
      JOIN songs s ON s.identity = p.identity
      WHERE s.status = 'ok' AND (p.tempo IS NULL OR abs(p.tempo - s.bpm) <= ${TEMPO_TOLERANCE_BPM})
      ON CONFLICT DO NOTHING
    `), () => []],
  ];

  /** Leaves a song without picks in `market` with the miss that explains why, if any. */
  function settle(market: string, identity: string, id: string, tempo: number | null, now: number) {
    if (hasPicks.get(market, identity)) {
      return;
    }
    if (servedByAnother.get({ market, id, identity, tempo })) {
      putMiss.run(market, identity, 'duplicate', now);
      return;
    }
    if (tempo !== null && !anyListingFits.get({ identity, tempo })) {
      putMiss.run(market, identity, 'tempo', now);
    }
  }

  function upsert(listing: Listing, now: number) {
    const { identity, bpm, durationS } = listing;
    const before = listingStatus.get(identity, bpm)?.status;
    const status = durationS !== undefined && durationS < MIN_SONG_SECONDS ? 'short' : 'ok';
    upsertListing.run({
      ...listing,
      isrc: listing.isrc ?? null,
      durationS: durationS ?? null,
      status,
      now,
    });

    const after = listingStatus.get(identity, bpm)?.status;
    if (after === 'ok' && before !== 'ok') {
      clearListingMisses.run(identity);
      placeAtNewListing.run({ identity, bpm });
    }
    if (after !== 'ok' && before === 'ok') {
      deleteListingPicks.run(identity, bpm);
    }
  }

  function found(market: string, identity: string, id: string, now: number) {
    deleteMiss.run(market, identity);
    const known = checkedFeatures.get(id) as StoredFeatures | undefined;
    deleteSongPicks.run(market, identity);

    const tempo = known?.tempo ?? null;
    placeAtListings.run({
      market,
      identity,
      id,
      lookedUpAt: now,
      tempo,
      speechiness: known?.speechiness ?? null,
      featuresAt: known?.features_at ?? null,
    });
    settle(market, identity, id, tempo, now);
  }

  function checked(id: string, { tempo, speechiness }: Features, now: number) {
    const held = holders.all(id) as unknown as Holder[];
    if (speechiness !== null && speechiness >= SPOKEN_WORD_SPEECHINESS) {
      deleteTrack.run(id);
      for (const { market, identity } of held) {
        putMiss.run(market, identity, 'spoken', now);
      }
      return;
    }

    if (tempo !== null) {
      deleteMisfits.run(id, tempo);
    }
    setFeatures.run(tempo, speechiness, now, id);
    for (const { market, identity, looked_up_at } of held) {
      placeAtListings.run({
        market,
        identity,
        id,
        lookedUpAt: looked_up_at,
        tempo,
        speechiness,
        featuresAt: now,
      });
      settle(market, identity, id, tempo, now);
    }
  }

  return {
    upsertListings: (listings, now) =>
      transaction(db, () => {
        for (const listing of listings) {
          upsert(listing, now);
        }
      }),
    applyLookup: (market, identity, id, now) =>
      transaction(db, () => {
        if (id !== null) {
          found(market, identity, id, now);
          return;
        }
        deleteSongPicks.run(market, identity);
        putMiss.run(market, identity, 'not-found', now);
      }),
    applyFeatures: (id, features, now) =>
      transaction(db, () => {
        if (features === null || (features.tempo === null && features.speechiness === null)) {
          markChecked.run(now, id);
          return;
        }
        checked(id, features, now);
      }),
    sweep: (market, now) =>
      transaction(db, () => {
        for (const [statement, params] of sweeps) {
          statement.run(...params(market, now));
        }
      }),
  };
}

export function utcDay(time: number): number {
  return Math.floor(time / DAY_MS);
}
