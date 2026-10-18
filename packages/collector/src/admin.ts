import { openWriter } from '@tempo-match/catalog';
import { runCommand, UsageError } from './commands.ts';
import { catalogConfig } from './config.ts';
import { Verification } from './status.ts';

const { catalogPath, market, reccoBeats } = catalogConfig(process.env);
const db = openWriter(catalogPath);
try {
  const verification = reccoBeats ? Verification.Checked : Verification.Unverified;
  const output = runCommand(process.argv.slice(2), { db, path: catalogPath, market, verification, now: Date.now() });
  console.log(output);
} catch (err) {
  if (!(err instanceof UsageError)) {
    throw err;
  }
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
