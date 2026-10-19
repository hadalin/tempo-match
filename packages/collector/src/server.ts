import { createServer, type Server } from 'node:http';
import { MAX_REPORT_BYTES, parseReport } from '@tempo-match/catalog';
import type { Reports } from './reports.ts';

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_LARGE = 413;
const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * The collector's port on the compose network: health and the matcher's minute reports. Health
 * fails while problems() names any, answering them as the body.
 */
export function collectorServer(received: Reports, problems: () => string[], now: () => number = Date.now): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const found = problems();
      res.writeHead(found.length > 0 ? HTTP_SERVICE_UNAVAILABLE : HTTP_OK).end(found.join('; ') || 'ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/reports') {
      res.writeHead(HTTP_NOT_FOUND).end();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REPORT_BYTES) {
        res.writeHead(HTTP_TOO_LARGE, { Connection: 'close' }).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const report = parseReport(Buffer.concat(chunks).toString('utf8'));
      if (!report) {
        res.writeHead(HTTP_BAD_REQUEST).end();
        return;
      }
      received.accept(report, now());
      res.writeHead(HTTP_NO_CONTENT).end();
    });
  });
}
