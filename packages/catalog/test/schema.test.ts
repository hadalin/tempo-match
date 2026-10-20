import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openReader, openWriter, SCHEMA_VERSION, SchemaVersionError } from '../src/index.ts';

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'catalog.db');
}

test('the writer creates the schema and its version in a new file', (t) => {
  const path = tempFile(t);
  openWriter(path).close();

  const db = openWriter(path);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  db.close();
});

test('a new file holds no upstream service back', (t) => {
  const db = openWriter(tempFile(t));
  const rows = db.prepare('SELECT service, banned_until, held_until, calls FROM upstream ORDER BY service').all();

  assert.deepEqual(rows.map((row) => ({ ...row })), ['deezer', 'getsongbpm', 'reccobeats', 'spotify'].map(
    (service) => ({ service, banned_until: 0, held_until: 0, calls: 0 }),
  ));
});

test('the reader refuses a file without the schema, then opens it read-only', (t) => {
  const path = tempFile(t);
  new DatabaseSync(path).close();
  assert.throws(() => openReader(path), SchemaVersionError);

  const writer = openWriter(path);
  const reader = openReader(path);
  assert.throws(() => reader.exec("DELETE FROM upstream"), /readonly/);
  reader.close();
  writer.close();
});

test('the writer drops the retired country counts from a catalog, keeping its songs', (t) => {
  const path = tempFile(t);
  const old = openWriter(path);
  old.exec("CREATE TABLE country_daily (day INTEGER NOT NULL, country TEXT NOT NULL, PRIMARY KEY (day, country)) STRICT, WITHOUT ROWID");
  old.exec("INSERT INTO songs (identity, bpm, title, artist, popularity, sources, status, seen_at) VALUES ('s', 120, 'S', 'A', 0.5, 1, 'ok', 0)");
  old.close();

  const db = openWriter(path);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'country_daily'").get(), undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM songs').get()?.n, 1);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  db.close();
});

test('the writer refuses a file of another schema version', (t) => {
  const path = tempFile(t);
  const other = new DatabaseSync(path);
  other.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  other.close();

  assert.throws(() => openWriter(path), SchemaVersionError);
});
