import type { DatabaseSync } from 'node:sqlite';
import type { Report, Suspect } from '@tempo-match/catalog';

export interface Reports {
  /** The suspects of the last report; empty until the first one after a start. */
  suspects(): Suspect[];
  accept(report: Report): void;
}

export function reports(): Reports {
  let last: Suspect[] = [];

  return {
    suspects: () => last,
    accept(report) {
      last = report.suspects;
    },
  };
}
