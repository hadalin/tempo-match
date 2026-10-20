export const MAX_REPORT_BYTES = 64 * 1024;
export const MAX_SUSPECTS = 200;
const COUNTRY = /^[A-Z]{2}$/;
const TRACK_ID = /^[0-9A-Za-z]{22}$/;

/** A pick that visitors in its market report as not playing. */
export interface Suspect {
  market: string;
  spotifyTrackId: string;
}

/** What the matcher sends the collector each minute: no IPs, only ids. */
export interface Report {
  /** Most flagged first. */
  suspects: Suspect[];
}

export function isTrackId(value: unknown): value is string {
  return typeof value === 'string' && TRACK_ID.test(value);
}

/** The report in `text`, or null when it is malformed or larger than its bounds. */
export function parseReport(text: string): Report | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }

  const { suspects } = (body ?? {}) as Partial<Record<keyof Report, unknown>>;
  if (!Array.isArray(suspects) || suspects.length > MAX_SUSPECTS || !suspects.every(isSuspect)) {
    return null;
  }
  return { suspects: suspects.map(({ market, spotifyTrackId }) => ({ market, spotifyTrackId })) };
}

function isSuspect(value: unknown): value is Suspect {
  const { market, spotifyTrackId } = (value ?? {}) as Partial<Suspect>;
  return typeof market === 'string' && COUNTRY.test(market) && isTrackId(spotifyTrackId);
}
