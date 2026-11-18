import { request as httpRequest } from 'node:http';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDaemonControl } from '../../apps/cli/src/cli/daemon-control.ts';
import { createTestHome, type TestHome } from './harness.ts';

// The phone reader (ADR-0017) reached as Tailscale Serve would forward it: the public Host and the person's login.
// In test mode the daemon binds its local sockets to free ports and reports them in diagnostics.
const HOST = 'example-mac.example-tailnet.ts.net';
const LOGIN = 'person@example.com';
const UI_PORT = 43182;
const PREVIEW_PORT = 43183;
const UI_ORIGIN = `https://${HOST}:${String(UI_PORT)}`;
const PREVIEW_ORIGIN = `https://${HOST}:${String(PREVIEW_PORT)}`;

let t: TestHome;
beforeEach(() => {
  t = createTestHome();
});
afterEach(async () => {
  await t.cleanup();
});

interface Envelope<T> {
  ok: boolean;
  data: T;
  error: { code: string; message: string; details: Record<string, unknown> };
}
interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: <T = Record<string, unknown>>() => Envelope<T>;
}

// The status code of a request written byte for byte (Node's client refuses a repeated Host).
function rawStatus(port: number, text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0)));
    socket.on('error', reject);
  });
}

type Who = 'person' | 'other' | 'none' | 'twice';
const identity = (who: Who): Record<string, string | string[]> =>
  who === 'person'
    ? { 'Tailscale-User-Login': LOGIN }
    : who === 'other'
      ? { 'Tailscale-User-Login': 'someone@example.com' }
      : who === 'twice'
        ? { 'Tailscale-User-Login': [LOGIN, LOGIN] }
        : {};

function send(
  port: number,
  path: string,
  options: {
    method?: string;
    host?: string;
    headers?: Record<string, string | string[]>;
    body?: unknown;
    // Sent as is, in chunks (no Content-Length), with the headers given.
    rawBody?: string;
  } = {},
): Promise<Response> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          Host: options.host ?? `${HOST}:${String(UI_PORT)}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json: <T>() => JSON.parse(text) as Envelope<T>,
          });
        });
      },
    );
    request.on('error', reject);
    if (options.rawBody !== undefined) {
      request.write(options.rawBody);
      request.end();
    } else {
      request.end(body);
    }
  });
}

interface Reader {
  uiPort: number;
  previewPort: number;
  // The phone UI's API as the person, from the phone screen's origin.
  api: (
    path: string,
    options?: { method?: string; body?: unknown; who?: Who },
  ) => Promise<Response>;
  // A view URL (public HTTPS) fetched through the local preview socket.
  file: (url: string, who?: Who, method?: string) => Promise<Response>;
}

function writeSettings(extra: Record<string, unknown> = {}, mobile: Record<string, unknown> = {}) {
  mkdirSync(t.home, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(t.home, 'listeners.json'),
    JSON.stringify({
      ...extra,
      mobile: { host: HOST, login: LOGIN, uiPort: UI_PORT, previewPort: PREVIEW_PORT, ...mobile },
    }),
  );
}

async function ipc<T>(method: string, params: unknown = {}): Promise<T> {
  const connection = await createDaemonControl({
    env: { VDE_OPEN_HOME: t.home },
    platform: process.platform,
    homeDir: process.env['HOME'] ?? '',
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  }).connectExisting();
  if (!connection) throw new Error('cannot connect to the daemon');
  try {
    const envelope = await connection.request<T>(method, params);
    if (!envelope.ok) throw new Error(JSON.stringify(envelope));
    return envelope.data;
  } finally {
    connection.close();
  }
}

async function startReader(): Promise<Reader> {
  const { mobileBoundPorts } = await ipc<{ mobileBoundPorts?: { ui: number; preview: number } }>(
    'daemon.diagnostics',
  );
  if (!mobileBoundPorts) throw new Error('the phone reader is not ready');
  return {
    uiPort: mobileBoundPorts.ui,
    previewPort: mobileBoundPorts.preview,
    api: (path, options = {}) =>
      send(mobileBoundPorts.ui, `/_/mobile/v1${path}`, {
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.body === undefined ? {} : { body: options.body }),
        headers: {
          ...identity(options.who ?? 'person'),
          ...(options.method !== undefined && options.method !== 'GET'
            ? { Origin: UI_ORIGIN }
            : {}),
        },
      }),
    file: (url, who = 'person', method = 'GET') => {
      const parsed = new URL(url);
      return send(mobileBoundPorts.preview, `${parsed.pathname}${parsed.search}`, {
        method,
        host: parsed.host,
        headers: identity(who),
      });
    },
  };
}

interface Row {
  documentId: string;
  title: string;
  format: string;
  revision: string;
  viewEpoch: string;
  effectiveMode: string | null;
}
interface Grant {
  grant: string;
  documentUrl: string | null;
  filesBaseUrl: string;
  mode: string;
  revision: string;
  viewEpoch: string;
  links: Array<{ linkId: string; href: string; kind: string }>;
}

async function rows(reader: Reader): Promise<Row[]> {
  const all: Row[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const page = (await reader.api(`/documents${query}`)).json<{
      documents: Row[];
      nextCursor: string | null;
    }>();
    if (!page.ok) throw new Error(JSON.stringify(page));
    all.push(...page.data.documents);
    cursor = page.data.nextCursor;
  } while (cursor !== null);
  return all;
}
const rowOf = async (reader: Reader, title: string) => {
  const found = (await rows(reader)).find((row) => row.title === title);
  if (!found) throw new Error(`${title} is not listed`);
  return found;
};
async function grantFor(reader: Reader, row: Row): Promise<Grant> {
  const response = await reader.api(`/documents/${row.documentId}/render-grants`, {
    method: 'POST',
    body: { revision: row.revision, viewEpoch: row.viewEpoch },
  });
  const envelope = response.json<Grant>();
  if (!envelope.ok) throw new Error(response.text);
  return envelope.data;
}
const check = async (reader: Reader, grant: string) =>
  (await reader.api('/render-grants/check', { method: 'POST', body: { grant } })).json<{
    valid: boolean;
  }>().data.valid;

async function open(paths: string[], extra: string[] = []) {
  const result = await t.run(['open', ...paths, '--no-open', '--json', ...extra]);
  if (result.exitCode !== 0) throw new Error(result.stdout + result.stderr);
}

describe('phone reader: starting and status', () => {
  it('is off without a mobile section, and ready with one, reporting the bookmark URL', async () => {
    t.write('a.md', '# a\n');
    await open(['a.md']);
    let status = (await t.run(['daemon', 'status', '--json'])).json<{ mobile: unknown }>().data;
    expect(status.mobile).toEqual({ state: 'disabled' });
    const diagnostics = await ipc<Record<string, unknown>>('daemon.diagnostics');
    expect(diagnostics['mobileBoundPorts']).toBeUndefined();

    writeSettings();
    await t.run(['daemon', 'restart', '--json']);
    status = (await t.run(['daemon', 'status', '--json'])).json<{ mobile: unknown }>().data;
    expect(status.mobile).toEqual({ state: 'ready', uiUrl: `${UI_ORIGIN}/` });
    expect((await t.run(['daemon', 'status'])).stdout).toContain(
      `phone reader: ready  ${UI_ORIGIN}/`,
    );
    // The test-only local ports are reported to diagnostics only, never in status or over HTTP.
    expect(JSON.stringify(status)).not.toContain('BoundPorts');
  });

  it.each([
    ['a host with a scheme', { host: `https://${HOST}` }, 'invalid:mobile.host'],
    ['a host with a port', { host: `${HOST}:443` }, 'invalid:mobile.host'],
    ['a missing login', { login: undefined }, 'invalid:mobile.login'],
    ['the same port twice', { previewPort: UI_PORT }, 'duplicate-port'],
  ])('settings with %s keep the PC running and report why', async (_name, mobile, reason) => {
    writeSettings({}, mobile);
    t.write('a.md', '# a\n');
    await open(['a.md']);
    const status = (await t.run(['daemon', 'status', '--json'])).json<{
      mobile: unknown;
      uiUrl: string;
    }>().data;
    expect(status.mobile).toEqual({ state: 'error', listener: null, port: null, reason });
    expect((await fetch(`${status.uiUrl}_/api/v1/status`)).status).toBe(200);
  });

  it('a busy phone port closes both phone listeners, keeps the PC, and a restart after it is freed is ready', async () => {
    // Without test mode, the configured ports are bound as they are (all chosen free here, one then taken).
    const free = async () => {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server;
    };
    const [pcUi, pcPreview, phonePreview] = await Promise.all([free(), free(), free()]);
    const busy = await free();
    const portOf = (server: ReturnType<typeof createServer>) =>
      (server.address() as { port: number }).port;
    const ports = {
      managementPort: portOf(pcUi),
      previewPort: portOf(pcPreview),
      uiPort: portOf(busy),
      phonePreview: portOf(phonePreview),
    };
    await Promise.all(
      [pcUi, pcPreview, phonePreview].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    writeSettings(
      { managementPort: ports.managementPort, previewPort: ports.previewPort },
      { uiPort: ports.uiPort, previewPort: ports.phonePreview },
    );
    const env = { VDE_OPEN_TEST_EPHEMERAL_PORTS: '' };
    try {
      t.write('a.md', '# a\n');
      expect((await t.run(['open', 'a.md', '--no-open', '--json'], { env })).exitCode).toBe(0);
      const status = (await t.run(['daemon', 'status', '--json'], { env })).json<{
        mobile: unknown;
        uiUrl: string;
      }>().data;
      expect(status.mobile).toEqual({
        state: 'error',
        listener: 'ui',
        port: ports.uiPort,
        reason: 'EADDRINUSE',
      });
      expect(status.uiUrl).toBe(`http://127.0.0.1:${String(ports.managementPort)}/`);
      // The phone preview that had started was closed again.
      await expect(
        send(ports.phonePreview, '/', { host: `${HOST}:${String(ports.phonePreview)}` }),
      ).rejects.toThrow();
      expect(busy.listening).toBe(true);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
    await t.run(['daemon', 'restart', '--json'], { env });
    const after = (await t.run(['daemon', 'status', '--json'], { env })).json<{ mobile: unknown }>()
      .data;
    expect(after.mobile).toEqual({
      state: 'ready',
      uiUrl: `https://${HOST}:${String(ports.uiPort)}/`,
    });
    await t.run(['daemon', 'stop'], { env });
  });
});

describe('phone reader: who may read', () => {
  it('only the configured person through the configured Host gets the list, stream, documents, files, and screen', async () => {
    writeSettings();
    t.write('a.md', '# 文書\n\n![図](pic.png)\n');
    t.write('pic.png', readFileSync(new URL('../fixtures/images/sample.png', import.meta.url)));
    await open(['a.md']);
    const reader = await startReader();
    const row = await rowOf(reader, '文書');
    const grant = await grantFor(reader, row);
    const image = `${grant.filesBaseUrl}pic.png`;
    expect(image.startsWith(`${PREVIEW_ORIGIN}/r/`)).toBe(true);
    expect((await reader.file(image)).status).toBe(200);

    for (const who of ['other', 'none', 'twice'] as const) {
      expect((await reader.api('/documents', { who })).status).toBe(403);
      expect((await reader.api('/events', { who })).status).toBe(403);
      expect(
        (
          await reader.api(
            `/documents/${row.documentId}/content?revision=${row.revision}&viewEpoch=${row.viewEpoch}`,
            { who },
          )
        ).status,
      ).toBe(403);
      expect((await send(reader.uiPort, '/', { headers: identity(who) })).status).toBe(403);
      expect((await reader.file(image, who)).status).toBe(404);
      expect((await reader.file(image, who, 'HEAD')).status).toBe(404);
    }
    // The configured Host only (not the local address, not another name).
    for (const host of [
      `127.0.0.1:${String(reader.uiPort)}`,
      `other.example:${String(UI_PORT)}`,
      HOST,
    ]) {
      expect(
        (await send(reader.uiPort, '/_/mobile/v1/documents', { host, headers: identity('person') }))
          .status,
      ).toBe(403);
    }
    const previewPath = new URL(image).pathname;
    expect(
      (
        await send(reader.previewPort, previewPath, {
          host: `127.0.0.1:${String(reader.previewPort)}`,
          headers: identity('person'),
        })
      ).status,
    ).toBe(404);
    // State changes need this screen's Origin, as JSON; a cross-site fetch is refused.
    const post = (headers: Record<string, string>) =>
      send(reader.uiPort, '/_/mobile/v1/render-grants/check', {
        method: 'POST',
        body: { grant: grant.grant },
        headers: { ...identity('person'), ...headers },
      });
    expect((await post({})).status).toBe(403);
    expect((await post({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ Origin: UI_ORIGIN, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post({ Origin: UI_ORIGIN })).status).toBe(200);
    // Exactly the JSON media type and valid JSON, however the body is sent.
    const raw = (type: string, text: string) =>
      send(reader.uiPort, '/_/mobile/v1/render-grants/check', {
        method: 'POST',
        rawBody: text,
        headers: { ...identity('person'), Origin: UI_ORIGIN, 'Content-Type': type },
      });
    const json = JSON.stringify({ grant: grant.grant });
    expect((await raw('text/plain', json)).status).toBe(400);
    expect((await raw('application/jsonp', json)).status).toBe(400);
    expect((await raw('application/json', '{"grant":')).status).toBe(400);
    expect((await raw('application/json; charset=utf-8', json)).status).toBe(200);
    // A second Host is ambiguous on both listeners, even when the first one is right.
    const twoHosts = (port: number, path: string, first: string) =>
      rawStatus(
        port,
        `GET ${path} HTTP/1.1\r\nHost: ${first}\r\nHost: other.example\r\nTailscale-User-Login: ${LOGIN}\r\nConnection: close\r\n\r\n`,
      );
    expect(
      await twoHosts(reader.uiPort, '/_/mobile/v1/documents', `${HOST}:${String(UI_PORT)}`),
    ).toBe(403);
    expect(await twoHosts(reader.previewPort, previewPath, `${HOST}:${String(PREVIEW_PORT)}`)).toBe(
      404,
    );
    // The same request with one Host is served.
    expect((await reader.file(image)).status).toBe(200);
  });

  it('offers no management routes, does not change the PC state, and never serves the PC screen', async () => {
    writeSettings();
    t.write('a.md', '# a\n');
    t.write('b.md', '# b\n');
    await open(['a.md', 'b.md']);
    const reader = await startReader();
    const before = (await t.run(['list', '--json'])).json<{ documents: unknown[] }>().data;
    const row = await rowOf(reader, 'a');
    for (const [method, path, body] of [
      ['DELETE', `/_/mobile/v1/documents/${row.documentId}`, undefined],
      ['POST', `/_/mobile/v1/documents/${row.documentId}/focus`, {}],
      [
        'POST',
        `/_/mobile/v1/documents/${row.documentId}/html-mode`,
        { mode: 'interactive', confirmed: true },
      ],
      ['PUT', '/_/mobile/v1/documents/order', { order: [] }],
      ['GET', '/_/mobile/v1/feedback', undefined],
      ['GET', '/_/api/v1/documents', undefined],
      ['GET', '/_/api/v1/status', undefined],
      ['POST', `/_/api/v1/documents/${row.documentId}/focus`, {}],
    ] as const) {
      const response = await send(reader.uiPort, path, {
        method,
        ...(body === undefined ? {} : { body }),
        headers: { ...identity('person'), Origin: UI_ORIGIN },
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect((await send(reader.uiPort, '/index.html', { headers: identity('person') })).status).toBe(
      404,
    );
    expect((await t.run(['list', '--json'])).json<{ documents: unknown[] }>().data).toEqual(before);
    // The list rows carry only what reading needs.
    const listed = (await reader.api('/documents')).json<{
      documents: Array<Record<string, unknown>>;
    }>().data.documents[0];
    expect(Object.keys(listed ?? {}).toSorted()).toEqual(
      [
        'documentId',
        'effectiveMode',
        'format',
        'openedAt',
        'revision',
        'sourceState',
        'title',
        'viewEpoch',
      ].toSorted(),
    );
  });
});

describe('phone reader: grants are bound to their audience', () => {
  it('a PC grant and a phone grant only work on their own preview; releasing one never touches the other', async () => {
    writeSettings();
    t.write('page.html', '<!doctype html><title>page</title><p>本文</p>');
    await open(['page.html']);
    const reader = await startReader();
    const row = await rowOf(reader, 'page');
    const phone = await grantFor(reader, row);
    const uiUrl = (await t.run(['ui', '--print-url'])).stdout.trim();
    const pcOrigin = uiUrl.replace(/\/$/, '');
    const pcResponse = await fetch(
      `${pcOrigin}/_/api/v1/documents/${row.documentId}/render-grants`,
      {
        method: 'POST',
        headers: { Origin: pcOrigin, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    const pc = ((await pcResponse.json()) as { data: { grant: string; documentUrl: string } }).data;
    expect((await fetch(pc.documentUrl)).status).toBe(200);
    expect((await reader.file(phone.documentUrl ?? '')).status).toBe(200);
    // Each key on the other preview: 404, and the probe does not revoke it.
    const pcPath = new URL(pc.documentUrl).pathname;
    const phonePath = new URL(phone.documentUrl ?? '').pathname;
    expect((await reader.file(`${PREVIEW_ORIGIN}${pcPath}`)).status).toBe(404);
    expect((await fetch(`${new URL(pc.documentUrl).origin}${phonePath}`)).status).toBe(404);
    expect((await fetch(pc.documentUrl)).status).toBe(200);
    expect((await reader.file(phone.documentUrl ?? '')).status).toBe(200);
    // Releasing on the wrong side does nothing.
    const released = (
      await reader.api('/render-grants/release', { method: 'POST', body: { grants: [pc.grant] } })
    ).json<{
      released: number;
    }>().data.released;
    expect(released).toBe(0);
    expect((await fetch(pc.documentUrl)).status).toBe(200);
    expect(await check(reader, pc.grant)).toBe(false);
    // The document is embeddable only by the phone screen, and asks for the public preview origin.
    const served = await reader.file(phone.documentUrl ?? '');
    const csp = String(served.headers['content-security-policy']);
    expect(csp).toContain(`frame-ancestors ${UI_ORIGIN}`);
    expect(csp).toContain(`${PREVIEW_ORIGIN}/r/${phone.grant}/`);
    expect(served.headers['cache-control']).toBe('no-store');
  });

  it('65 phone grants retire only the oldest phone grant; the PC view keeps loading', async () => {
    writeSettings();
    t.write('pic.png', readFileSync(new URL('../fixtures/images/sample.png', import.meta.url)));
    await open(['pic.png']);
    const reader = await startReader();
    const row = await rowOf(reader, 'pic.png');
    const uiUrl = (await t.run(['ui', '--print-url'])).stdout.trim().replace(/\/$/, '');
    const pc = (
      (await (
        await fetch(`${uiUrl}/_/api/v1/documents/${row.documentId}/render-grants`, {
          method: 'POST',
          headers: { Origin: uiUrl, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).json()) as { data: { documentUrl: string } }
    ).data;
    const phone: Grant[] = [];
    for (let index = 0; index < 65; index += 1) phone.push(await grantFor(reader, row));
    expect(await check(reader, phone[0]?.grant ?? '')).toBe(false);
    expect(await check(reader, phone[1]?.grant ?? '')).toBe(true);
    expect(await check(reader, phone[64]?.grant ?? '')).toBe(true);
    expect((await fetch(pc.documentUrl)).status).toBe(200);
  });
});

describe('phone reader: view generations', () => {
  it('Static→Interactive→Static, Interactive→Static→Interactive, and close→reopen each retire the earlier grants', async () => {
    writeSettings();
    t.write('demo.html', '<!doctype html><title>demo</title><p>demo</p><script>1</script>');
    t.write('data.json', '{"a":1}');
    await open(['demo.html', '--asset', 'data.json']);
    const reader = await startReader();
    const issue = async () => {
      const row = await rowOf(reader, 'demo');
      return { row, grant: await grantFor(reader, row) };
    };
    const dead = async (grant: Grant) => {
      expect((await reader.file(grant.documentUrl ?? '')).status).toBe(404);
      expect((await reader.file(grant.documentUrl ?? '', 'person', 'HEAD')).status).toBe(404);
      expect(await check(reader, grant.grant)).toBe(false);
    };
    const live = async (grant: Grant) => {
      expect((await reader.file(grant.documentUrl ?? '')).status).toBe(200);
      expect(await check(reader, grant.grant)).toBe(true);
    };
    const allow = (mode: 'interactive' | 'static') => open(['demo.html', '--html-mode', mode]);

    const s1 = await issue();
    expect(s1.grant.mode).toBe('static');
    expect(s1.row.effectiveMode).toBe('static');
    await live(s1.grant);
    await allow('interactive');
    const i1 = await issue();
    expect(i1.grant.mode).toBe('interactive');
    expect(i1.row.effectiveMode).toBe('interactive');
    await dead(s1.grant);
    await live(i1.grant);
    // The registered data file of the interactive view, readable from the opaque document.
    const data = await reader.file(`${i1.grant.filesBaseUrl}data.json`);
    expect(data.status).toBe(200);
    expect(data.headers['access-control-allow-origin']).toBe('null');
    expect((await reader.file(`${i1.grant.filesBaseUrl}unregistered.json`)).status).toBe(404);
    await allow('static');
    const s2 = await issue();
    await dead(i1.grant);
    await dead(s1.grant);
    await live(s2.grant);
    await allow('interactive');
    const i2 = await issue();
    await dead(s2.grant);
    await dead(i1.grant);
    await live(i2.grant);

    // A grant asked for with an earlier view generation is refused (the phone fetches the list again).
    const stale = await reader.api(`/documents/${s2.row.documentId}/render-grants`, {
      method: 'POST',
      body: { revision: s2.row.revision, viewEpoch: s2.row.viewEpoch },
    });
    expect(stale.status).toBe(409);
    expect(stale.json().error).toEqual({
      code: 'E_VIEW_STALE',
      message: 'The document changed. Fetch the list again.',
      retryable: false,
      details: {},
    });

    await t.run(['close', 'demo.html', '--json']);
    await dead(i2.grant);
    await open(['demo.html']);
    const reopened = await issue();
    await dead(i2.grant);
    await live(reopened.grant);
    expect(reopened.row.viewEpoch).not.toBe(i2.row.viewEpoch);
  });

  it('a new revision retires the old grant and refuses requests for the old revision; a closed document is 404', async () => {
    writeSettings();
    t.write('a.md', '# a\n\n![図](pic.png)\n');
    t.write('pic.png', readFileSync(new URL('../fixtures/images/sample.png', import.meta.url)));
    await open(['a.md']);
    const reader = await startReader();
    const before = await rowOf(reader, 'a');
    const grant = await grantFor(reader, before);
    t.write('a.md', '# a\n\n![図](pic.png)\n\nupdated\n');
    await t.run(['refresh', before.documentId, '--json']);
    const after = await rowOf(reader, 'a');
    expect(after.revision).not.toBe(before.revision);
    expect((await reader.file(`${grant.filesBaseUrl}pic.png`)).status).toBe(404);
    const old = await reader.api(
      `/documents/${before.documentId}/content?revision=${before.revision}&viewEpoch=${before.viewEpoch}`,
    );
    expect(old.status).toBe(409);
    await t.run(['close', 'a.md', '--json']);
    const closed = await reader.api(
      `/documents/${after.documentId}/content?revision=${after.revision}&viewEpoch=${after.viewEpoch}`,
    );
    expect(closed.status).toBe(404);
    expect(closed.json().error.details).toEqual({});
  });
});

describe('phone reader: list and content', () => {
  it('reads a multi-page UTF-8 Markdown exactly; a continuation stops once the document changes; other cursors are refused', async () => {
    writeSettings();
    // Over 1 MiB of multibyte text, so the content spans pages and pages may end mid-character.
    const text = `# 長文\n\n${'日本語の本文と絵文字🙂を含む行です。\n'.repeat(30_000)}`;
    t.write('long.md', text);
    t.write('other.md', '# other\n');
    await open(['long.md', 'other.md']);
    const reader = await startReader();
    const row = await rowOf(reader, '長文');
    let content = '';
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string =
        cursor === null
          ? `/documents/${row.documentId}/content?revision=${row.revision}&viewEpoch=${row.viewEpoch}`
          : `/documents/${row.documentId}/content?cursor=${encodeURIComponent(cursor)}`;
      const page = (await reader.api(path)).json<{ content: string; nextCursor: string | null }>();
      expect(page.ok).toBe(true);
      content += page.data.content;
      cursor = page.data.nextCursor;
      pages += 1;
    } while (cursor !== null);
    // About 1.8 MB: two 1 MiB pages (a continuation that fell back to the 16 KiB default would take 40).
    expect(pages).toBe(2);
    expect(content).toBe(text);

    const first = (
      await reader.api(
        `/documents/${row.documentId}/content?revision=${row.revision}&viewEpoch=${row.viewEpoch}`,
      )
    ).json<{ nextCursor: string }>().data.nextCursor;
    // Not for another document.
    const other = await rowOf(reader, 'other');
    expect(
      (
        await reader.api(
          `/documents/${other.documentId}/content?cursor=${encodeURIComponent(first)}`,
        )
      ).status,
    ).toBe(409);
    // Not a cursor of the PC's read.
    const pcCursor = (await t.run(['read', row.documentId, '--max-bytes', '1024', '--json'])).json<{
      nextCursor: string;
    }>().data.nextCursor;
    expect(
      (
        await reader.api(
          `/documents/${row.documentId}/content?cursor=${encodeURIComponent(pcCursor)}`,
        )
      ).status,
    ).toBe(409);
    // Once the document changes, the continuation stops.
    t.write('long.md', `${text}追記\n`);
    await t.run(['refresh', row.documentId, '--json']);
    expect(
      (await reader.api(`/documents/${row.documentId}/content?cursor=${encodeURIComponent(first)}`))
        .status,
    ).toBe(409);
  });

  it('lists 501 documents in two pages; a change mid-list asks for a fresh start, which has no gap or duplicate', async () => {
    writeSettings();
    for (let index = 0; index < 501; index += 1) {
      t.write(`docs/d${String(index).padStart(3, '0')}.md`, `# d${String(index)}\n`);
    }
    await open(['docs', '--recursive']);
    const reader = await startReader();
    const first = (await reader.api('/documents')).json<{
      documents: Row[];
      nextCursor: string | null;
    }>().data;
    expect(first.documents).toHaveLength(500);
    expect(first.nextCursor).not.toBeNull();
    t.write('late.md', '# late\n');
    await open(['late.md']);
    const next = await reader.api(
      `/documents?cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    expect(next.status).toBe(409);
    const all = await rows(reader);
    expect(all).toHaveLength(502);
    expect(new Set(all.map((row) => row.documentId)).size).toBe(502);
    // A cursor of the PC list is not accepted.
    const pcCursor = (await t.run(['list', '--limit', '10', '--json'])).json<{
      nextCursor: string;
    }>().data.nextCursor;
    expect((await reader.api(`/documents?cursor=${encodeURIComponent(pcCursor)}`)).status).toBe(
      409,
    );
  });
});

describe('phone reader: links and notifications', () => {
  it('resolves a link to an open document without changing the PC, and an unregistered one to the same "not open"', async () => {
    writeSettings();
    t.write('a.md', '# A\n\n[B](b.md) [C](c.md) [外部](https://example.com/)\n');
    t.write('b.md', '# B\n');
    t.write('c.md', '# C\n');
    await open(['a.md', 'b.md']);
    const reader = await startReader();
    const a = await rowOf(reader, 'A');
    const b = await rowOf(reader, 'B');
    const grant = await grantFor(reader, a);
    const linkOf = (href: string) => grant.links.find((link) => link.href === href)?.linkId ?? '';
    const statusBefore = await (
      await fetch(`${(await t.run(['ui', '--print-url'])).stdout.trim()}_/api/v1/status`)
    ).json();
    const resolve = async (linkId: string) =>
      (
        await reader.api('/links/resolve', { method: 'POST', body: { grant: grant.grant, linkId } })
      ).json<{
        status: string;
        documentId?: string;
      }>().data;
    expect(await resolve(linkOf('b.md'))).toEqual({ status: 'open', documentId: b.documentId });
    expect(await resolve(linkOf('c.md'))).toEqual({ status: 'not-open' });
    expect(await resolve(linkOf('https://example.com/'))).toEqual({ status: 'not-open' });
    expect(await resolve('lnk_9999')).toEqual({ status: 'not-open' });
    const statusAfter = await (
      await fetch(`${(await t.run(['ui', '--print-url'])).stdout.trim()}_/api/v1/status`)
    ).json();
    expect(statusAfter).toEqual(statusBefore);
    expect((await rows(reader)).map((row) => row.title).toSorted()).toEqual(['A', 'B']);
    // A dead view resolves nothing.
    await reader.api('/render-grants/release', { method: 'POST', body: { grants: [grant.grant] } });
    const dead = await reader.api('/links/resolve', {
      method: 'POST',
      body: { grant: grant.grant, linkId: linkOf('b.md') },
    });
    expect(dead.status).toBe(409);
  });

  it('streams hello, then changed for opens and permission changes, and nothing about focus or questions', async () => {
    writeSettings();
    t.write('a.md', '# a\n');
    t.write('page.html', '<!doctype html><title>p</title>');
    await open(['a.md', 'page.html']);
    const reader = await startReader();
    const received: string[] = [];
    const controller = new AbortController();
    const stream = new Promise<void>((resolve) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: reader.uiPort,
          path: '/_/mobile/v1/events',
          headers: { Host: `${HOST}:${String(UI_PORT)}`, ...identity('person') },
          signal: controller.signal,
        },
        (response) => {
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            for (const line of chunk.split('\n'))
              if (line.startsWith('data: ')) received.push(line.slice(6));
          });
          response.on('close', () => resolve());
        },
      );
      request.on('error', () => resolve());
      request.end();
    });
    const until = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (received.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await until(1);
    await t.run(['focus', 'a.md', '--json']);
    t.write('b.md', '# b\n');
    await open(['b.md']);
    await until(2);
    await open(['page.html', '--html-mode', 'interactive']);
    await until(3);
    controller.abort();
    await stream;
    const events = received.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ type: 'hello' });
    expect(events.slice(1).every((event) => event['type'] === 'changed')).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const event of events) {
      expect(
        Object.keys(event).every((key) => ['type', 'daemonId', 'documentId'].includes(key)),
      ).toBe(true);
    }
  });
});

describe('vo mobile enable / status / disable (with a stand-in tailscale command)', () => {
  // A tailscale CLI stand-in: it answers status and serve from a JSON file and records serve changes there.
  function fakeTailscale(): {
    env: Record<string, string>;
    state: () => { web: Record<string, string> };
  } {
    const dir = join(t.home, '..', 'fake-tailscale');
    mkdirSync(dir, { recursive: true });
    const stateFile = join(dir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ web: {} }));
    const script = join(dir, 'tailscale');
    writeFileSync(
      script,
      `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
process.stderr.write('Warning: client version differs\\n');
if (args[0] === 'status') {
  console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: ${JSON.stringify(`${HOST}.`)}, UserID: 1 }, User: { '1': { LoginName: ${JSON.stringify(LOGIN)} } } }));
} else if (args[0] === 'serve' && args[1] === 'status') {
  const Web = {}; const TCP = {};
  for (const [port, proxy] of Object.entries(state.web)) { TCP[port] = { HTTPS: true }; Web[${JSON.stringify(HOST)} + ':' + port] = { Handlers: { '/': { Proxy: proxy } } }; }
  console.log(JSON.stringify({ TCP, Web }));
} else {
  const port = args.find((a) => a.startsWith('--https=')).slice(8);
  if (args.includes('off')) delete state.web[port]; else state.web[port] = args[args.length - 1];
  fs.writeFileSync(file, JSON.stringify(state));
}
`,
      { mode: 0o755 },
    );
    return {
      env: { VDE_OPEN_TAILSCALE: script },
      state: () => JSON.parse(readFileSync(stateFile, 'utf8')) as { web: Record<string, string> },
    };
  }

  it('enable fills in the settings and the forwards, status shows them, disable takes back only its own', async () => {
    const tailscale = fakeTailscale();
    t.write('a.md', '# a\n');
    await open(['a.md']);
    const enabled = await t.run(['mobile', 'enable', '--json'], { env: tailscale.env });
    expect(enabled.exitCode).toBe(0);
    expect(enabled.json().data).toEqual({
      uiUrl: `${UI_ORIGIN}/`,
      host: HOST,
      login: LOGIN,
      serve: { '43182': 'added', '43183': 'added' },
    });
    expect(tailscale.state().web).toEqual({
      '43182': 'http://127.0.0.1:43182',
      '43183': 'http://127.0.0.1:43183',
    });
    // The restarted daemon serves the reader with the written settings.
    const reader = await startReader();
    expect((await rows(reader)).map((row) => row.title)).toEqual(['a']);
    const text = await t.run(['mobile', 'status'], { env: tailscale.env });
    expect(text.stdout).toContain(`settings: ${UI_ORIGIN}/`);
    expect(text.stdout).toContain(`daemon: ready ${UI_ORIGIN}/`);
    expect(text.stdout).toContain('serve: 43182 ours, 43183 ours');

    const disabled = await t.run(['mobile', 'disable', '--json'], { env: tailscale.env });
    expect(disabled.json().data).toEqual({
      wasEnabled: true,
      serve: { '43182': 'removed', '43183': 'removed' },
    });
    expect(tailscale.state().web).toEqual({});
    const status = (await t.run(['daemon', 'status', '--json'])).json<{ mobile: unknown }>().data;
    expect(status.mobile).toEqual({ state: 'disabled' });
    // Without settings, status still shows the daemon's reader state.
    const after = await t.run(['mobile', 'status'], { env: tailscale.env });
    expect(after.stdout).toContain('settings: none (vo mobile enable)');
    expect(after.stdout).toContain('daemon: disabled');
  });

  it('enable reports a missing tailscale command and changes nothing', async () => {
    const result = await t.run(['mobile', 'enable', '--json'], {
      env: { VDE_OPEN_TAILSCALE: join(t.home, '..', 'no-tailscale-here') },
    });
    expect(result.json().error.code).toBe('E_TAILSCALE_UNAVAILABLE');
  });
});
