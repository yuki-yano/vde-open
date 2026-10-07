// A stand-in for Chrome in tests. Speaks just enough of the DevTools protocol over --remote-debugging-pipe
// (fd 3 in, fd 4 out) to print a fixed PDF. Run as `node fake-browser.fixture.ts <mode> <record file> <browser flags...>`.
// Modes: ok, old (reports Chrome 120), hang (never answers the print), crash (exits while printing),
// garbage (returns something that is not a PDF), linger (does not exit on Browser.close),
// stale (reports the load of the blank page first and the real load later; printing before it gives no PDF),
// broken (writes a message that is not JSON), locked (leaves a directory in its profile that cannot be removed).
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

const [mode = 'ok', record = '', ...flags] = process.argv.slice(2);
// Sockets, not fs streams: a pending fs read on a pipe would keep process.exit from finishing.
const input = new Socket({ fd: 3, readable: true, writable: false });
const output = new Socket({ fd: 4, readable: false, writable: true });

const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';

function note(entry: Record<string, unknown>): void {
  if (record !== '') appendFileSync(record, `${JSON.stringify(entry)}\n`);
}

function reply(id: number, result: unknown, sessionId?: string): void {
  output.write(`${JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) })}\0`);
}

note({ flags, pid: process.pid });
if (mode === 'locked') {
  const profile = flags
    .find((flag) => flag.startsWith('--user-data-dir='))
    ?.slice('--user-data-dir='.length);
  if (profile !== undefined) {
    mkdirSync(join(profile, 'locked'), { recursive: true });
    writeFileSync(join(profile, 'locked', 'file'), 'x');
    chmodSync(join(profile, 'locked'), 0o500);
  }
}
let printed = 0;
let loaded = false;
const lifecycle = (sessionId: string | undefined, loaderId: string) =>
  output.write(
    `${JSON.stringify({ method: 'Page.lifecycleEvent', sessionId, params: { frameId: 'frame', loaderId, name: 'load', timestamp: 1 } })}\0`,
  );
let buffered = '';
input.setEncoding('utf8');
input.on('data', (chunk: string) => {
  buffered += chunk;
  let end = buffered.indexOf('\0');
  while (end !== -1) {
    const message = JSON.parse(buffered.slice(0, end)) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
      sessionId?: string;
    };
    buffered = buffered.slice(end + 1);
    end = buffered.indexOf('\0');
    const { id, method, params, sessionId } = message;
    switch (method) {
      case 'Browser.getVersion':
        reply(id, { product: mode === 'old' ? 'HeadlessChrome/120.0.0.0' : 'Chrome/150.0.0.0' });
        break;
      case 'Target.createTarget':
        reply(id, { targetId: 'target' });
        break;
      case 'Target.attachToTarget':
        reply(id, { sessionId: 'session' });
        break;
      case 'Page.navigate': {
        const url = String(params['url']);
        const path = fileURLToPath(url);
        const directory = dirname(path);
        note({
          page: readFileSync(path, 'utf8'),
          stylesheets: Object.fromEntries(
            readdirSync(directory)
              .filter((name) => name.endsWith('.css'))
              .map((name) => [name, readFileSync(join(directory, name), 'utf8')]),
          ),
        });
        if (mode === 'stale') lifecycle(sessionId, 'blank');
        reply(id, { frameId: 'frame', loaderId: 'document' }, sessionId);
        const load = () => {
          loaded = true;
          lifecycle(sessionId, 'document');
        };
        if (mode === 'stale') setTimeout(load, 200);
        else load();
        break;
      }
      case 'Page.printToPDF':
        if (mode === 'hang') break;
        if (mode === 'crash') process.exit(3);
        if (mode === 'broken') {
          output.write('{not json\0');
          break;
        }
        reply(id, { stream: 'stream' }, sessionId);
        break;
      case 'IO.read': {
        const body = mode === 'garbage' || !loaded ? 'not a pdf' : PDF;
        // In two chunks, to check that the reader joins them.
        const half = Math.ceil(body.length / 2);
        const part = printed === 0 ? body.slice(0, half) : body.slice(half);
        printed += 1;
        reply(
          id,
          { data: Buffer.from(part).toString('base64'), base64Encoded: true, eof: printed === 2 },
          sessionId,
        );
        break;
      }
      case 'Browser.close':
        reply(id, {});
        note({ closed: true });
        if (mode !== 'linger') setTimeout(() => process.exit(0), 10);
        break;
      default:
        reply(id, {}, sessionId);
    }
  }
});
// Keep running until told to close or stopped (a real browser does not exit on its own either).
setInterval(() => undefined, 1000);
