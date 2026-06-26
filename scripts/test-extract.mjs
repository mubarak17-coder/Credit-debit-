import handler from '../api/extract.js';
import { Readable } from 'stream';

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return res;
}

function mockReq(method, bodyObj) {
  const buf = Buffer.from(JSON.stringify(bodyObj));
  const stream = Readable.from([buf]);
  stream.method = method;
  return stream;
}

async function run(name, req, expected) {
  const res = mockRes();
  await handler(req, res);
  const ok = res.statusCode === expected;
  console.log(`${ok ? '✓' : '✗'} ${name}: got ${res.statusCode}, expected ${expected} — ${JSON.stringify(res.body)}`);
  return ok;
}

let pass = 0, total = 0;

const tinyPdf = Buffer.from('%PDF-1.4\n%EOF').toString('base64');

total++; if (await run('GET → 405', mockReq('GET', {}), 405)) pass++;
total++; if (await run('missing base64 → 400', mockReq('POST', { mediaType: 'application/pdf' }), 400)) pass++;
total++; if (await run('empty base64 → 400', mockReq('POST', { base64: '', mediaType: 'application/pdf' }), 400)) pass++;

delete process.env.AI_GATEWAY_API_KEY;
total++; if (await run('no API key → 503', mockReq('POST', { base64: tinyPdf, mediaType: 'application/pdf' }), 503)) pass++;

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
