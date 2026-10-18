import { openWriter, transitions } from '@tempo-match/catalog';

export function memoryCatalog() {
  const db = openWriter(':memory:');
  return { db, t: transitions(db) };
}
