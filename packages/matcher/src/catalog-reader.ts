import type { DatabaseSync } from 'node:sqlite';
import { matcherQueries, openReader, SCHEMA_VERSION, schemaVersion, type MatcherQueries } from '@tempo-match/catalog';

const RETRY_MS = 5_000;

export interface CatalogReader {
  /** The catalog's queries, or null until the collector has created a catalog of this version. */
  queries(): MatcherQueries | null;
  close(): void;
}

/** Opens the catalog read-only, retrying every few seconds while it is missing or of another version. */
export function catalogReader(path: string, retryMs = RETRY_MS): CatalogReader {
  let db: DatabaseSync | null = null;
  let queries: MatcherQueries | null = null;
  let lastProblem = '';

  function close() {
    db?.close();
    db = null;
    queries = null;
  }

  function check() {
    try {
      if (db && schemaVersion(db) === SCHEMA_VERSION) {
        return;
      }
      close();
      db = openReader(path);
      queries = matcherQueries(db);
      lastProblem = '';
      console.log(`Serving songs from ${path}`);
    } catch (err) {
      close();
      const problem = (err as Error).message;
      if (problem !== lastProblem) {
        lastProblem = problem;
        console.error(`Waiting for the catalog: ${problem}`);
      }
    }
  }

  check();
  const timer = setInterval(check, retryMs);
  timer.unref();
  return {
    queries: () => queries,
    close() {
      clearInterval(timer);
      close();
    },
  };
}
