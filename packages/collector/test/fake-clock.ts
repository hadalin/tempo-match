import type { Clock } from '../src/clock.ts';

export const NOW = Date.UTC(2026, 9, 18, 12);

export interface FakeClock extends Clock {
  advance(ms: number): void;
  /** Wall-clock times at which each sleep ended. */
  wakes: number[];
}

/** A clock whose sleeps pass at once, moving both clocks forward. */
export function fakeClock(start = NOW): FakeClock {
  let wall = start;
  let mono = 0;
  const wakes: number[] = [];
  const advance = (ms: number) => {
    wall += ms;
    mono += ms;
  };
  return {
    now: () => wall,
    monotonic: () => mono,
    sleep: async (ms) => {
      advance(ms);
      wakes.push(wall);
    },
    advance,
    wakes,
  };
}
