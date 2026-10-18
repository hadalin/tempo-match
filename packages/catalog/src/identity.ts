import { normalize, normalizeTitle } from './normalize.ts';

/** One key for every listing of a recording, whatever its source; it never changes. */
export function identityOf(title: string, artist: string): string {
  return JSON.stringify([normalizeTitle(title), normalize(artist)]);
}
