import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTitle } from '../src/normalize.ts';

const SAME_TITLES: [string, string][] = [
  ['Hotel California', 'hotel california'],
  ['  Hotel   California ', 'Hotel California'],
  ['Hey Jude', 'Hey Jude - Remastered 2015'],
  ['Dreams', 'Dreams - 2004 Remaster'],
  ['Come Together', 'Come Together (Remastered)'],
  ['Purple Rain', 'Purple Rain - Live'],
  ['Purple Rain', 'Purple Rain – Live at the Carrier Dome, Syracuse, NY, 3/30/85'],
  ['Shut Up and Dance', 'Shut Up and Dance - Radio Edit'],
  ['Stay', 'Stay (feat. Mikky Ekko)'],
  ['Stay', 'Stay [feat. Mikky Ekko]'],
  ['Stay', 'Stay (ft. Mikky Ekko) - Remastered 2011'],
  ['Perfect', 'Perfect (with Beyoncé)'],
  ['Wonderwall', 'Wonderwall - Mono Version'],
  ["Don't Stop Me Now", 'Don’t Stop Me Now'],
  ["Sweet Child O' Mine", 'Sweet Child O Mine'],
  ['Rock & Roll', 'Rock and Roll'],
  ['Señorita', 'Señorita'],
  ['Déjà Vu', 'Déjà Vu'],
  ['"Heroes"', 'Heroes'],
  ['Hello, Goodbye', 'Hello Goodbye'],
  ['(I Can’t Get No) Satisfaction', "(I Can't Get No) Satisfaction"],
];

for (const [a, b] of SAME_TITLES) {
  test(`normalizes "${a}" and "${b}" to the same title`, () => {
    assert.equal(normalizeTitle(a), normalizeTitle(b));
  });
}

const DIFFERENT_TITLES: [string, string][] = [
  ['When', 'When All the World Is Young, Lad'],
  ['Satisfaction', '(I Can’t Get No) Satisfaction'],
  ['Halo', 'Halo - Interlude'],
  ['Hello', 'Hello (Interlude)'],
  ['Song', 'Song 2'],
];

for (const [a, b] of DIFFERENT_TITLES) {
  test(`keeps "${a}" and "${b}" apart`, () => {
    assert.notEqual(normalizeTitle(a), normalizeTitle(b));
  });
}
