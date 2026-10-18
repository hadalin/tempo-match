import { setTimeout as delay } from 'node:timers/promises';

export interface Clock {
  /** Wall-clock milliseconds since the epoch, for stored times and UTC days. */
  now(): number;
  /** Milliseconds that never go back, for spacing calls. */
  monotonic(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: Date.now,
  monotonic: () => performance.now(),
  sleep: async (ms) => {
    await delay(ms);
  },
};
