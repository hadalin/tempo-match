// Karaoke, backing tracks, skits, interviews and audiobook chapters that the duration and
// speechiness checks let through. Opera titles such as "Act 2, Scene 12" must still pass.
const NON_SONG_TITLE = new RegExp(
  [
    String.raw`\b(skits?|interview|commentary|karaoke|(performance|backing) track|made famous by|originally performed by|sound-a-like|in the style of)\b`,
    String.raw`\b(kapitel|chapter|cap[ií]tulo|chapitre|capitolo|hoofdstuk|kapittel|rozdział)\s*\d+`,
    String.raw`^scene\s*\d+\b`,
    String.raw`[([]\s*instrumental(\s+version)?\s*[)\]]`,
  ].join('|'),
  'iu',
);

export function isNonSong(title: string): boolean {
  return NON_SONG_TITLE.test(title);
}
