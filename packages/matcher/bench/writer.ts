import { parentPort, workerData } from 'node:worker_threads';
import { openWriter, transitions } from '@tempo-match/catalog';

const { path, market, identities, firstId, everyMs } = workerData as {
  path: string;
  market: string;
  identities: string[];
  firstId: number;
  everyMs: number;
};
const t = transitions(openWriter(path));
let written = 0;
const timer = setInterval(() => {
  const identity = identities[Math.floor(Math.random() * identities.length)];
  t.applyLookup(market, identity, (firstId + written++).toString(36).padStart(22, '0'), Date.now());
}, everyMs);
parentPort!.on('message', () => {
  clearInterval(timer);
  parentPort!.postMessage(written);
});
