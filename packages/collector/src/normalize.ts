const TRAILING_SEGMENT = /(?:\s+[-–—]\s+([^-–—]+)|\s*\(([^()]*)\)|\s*\[([^[\]]*)\])$/;
const QUALIFIER =
  /\b(?:feat|ft|featuring|with|remaster|remastered|live|edit|version|mono|stereo)\b/;
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Two listings of one recording normalize to the same title, e.g. "Song - Remastered 2011". */
export function normalizeTitle(title: string): string {
  return withoutQualifiers(normalize(title))
    .replaceAll('&', ' and ')
    .replace(PUNCTUATION, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutQualifiers(title: string): string {
  const match = TRAILING_SEGMENT.exec(title);
  const segment = match?.slice(1).find((group) => group !== undefined);
  if (!match || match.index === 0 || !segment || !QUALIFIER.test(segment)) {
    return title;
  }
  return withoutQualifiers(title.slice(0, match.index));
}
