import type { DatabaseSync } from 'node:sqlite';
import { utcDay, type Report, type Suspect } from '@tempo-match/catalog';

export interface Reports {
  /** The suspects of the last report; empty until the first one after a start. */
  suspects(): Suspect[];
  accept(report: Report, now: number): void;
}

export function reports(db: DatabaseSync): Reports {
  const addCounts = db.prepare(`
    INSERT INTO country_daily (day, country, served, fallback, empty, dead) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (day, country) DO UPDATE SET served = served + excluded.served,
      fallback = fallback + excluded.fallback, empty = empty + excluded.empty, dead = dead + excluded.dead
  `);
  let last: Suspect[] = [];

  return {
    suspects: () => last,
    accept(report, now) {
      last = report.suspects;
      const day = utcDay(now);
      for (const [country, { served, fallback, empty, dead }] of Object.entries(report.countries)) {
        addCounts.run(day, country, served, fallback, empty, dead);
      }
    },
  };
}
