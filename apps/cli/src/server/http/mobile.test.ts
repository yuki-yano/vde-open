import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  isConfiguredPerson,
  startMobileServer,
  type MobileDeps,
  type MobileServer,
} from './mobile.ts';
import { startPreviewServer, type PreviewServer } from './preview.ts';

// Requests as Tailscale Serve forwards them (ADR-0017): the public Host and the person's login.
const settings = {
  host: 'example-mac.example-tailnet.ts.net',
  login: 'person@example.com',
  uiPort: 43182,
  previewPort: 43183,
};
const UI_HOST = `${settings.host}:43182`;
const UI_ORIGIN = `https://${UI_HOST}`;
const PREVIEW_HOST = `${settings.host}:43183`;
const GRANT = 'g'.repeat(43);
const FILE = `/r/${GRANT}/files/pic.png`;

type Who = 'person' | 'other' | 'none' | 'twice';
const identity = (who: Who): Record<string, string | string[]> =>
  who === 'person'
    ? { 'Tailscale-User-Login': settings.login }
    : who === 'other'
      ? { 'Tailscale-User-Login': 'someone@example.com' }
      : who === 'twice'
        ? { 'Tailscale-User-Login': [settings.login, settings.login] }
        : {};

let webRoot: string;
let ui: MobileServer;
let preview: PreviewServer;
// A listener a single test starts for itself.
let server: MobileServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

// Both listeners keep nothing between requests, so the tests share them.
beforeAll(async () => {
  webRoot = mkdtempSync(join(tmpdir(), 'vde-open-mobile-'));
  writeFileSync(join(webRoot, 'index.html'), 'the PC screen');
  writeFileSync(join(webRoot, 'mobile.html'), 'the phone screen');
  ui = await startMobileServer(
    {
      daemonId: 'daemon_test',
      settings,
      webRoot,
      isOpen: () => true,
      isStopping: () => false,
      // Only what the requests that pass the checks reach.
      documents: {
        state: { catalogVersion: 1 },
        list: () => ({ catalogVersion: 1, data: { documents: [], nextCursor: null } }),
      },
      render: { checkMobile: (grant: string) => grant === GRANT },
    } as unknown as MobileDeps,
    { port: 0 },
  );
  preview = await startPreviewServer({
    resolve: (grant, logicalPath) =>
      Promise.resolve(
        grant === GRANT && logicalPath === 'pic.png'
          ? {
              body: Buffer.from('png'),
              mime: 'image/png',
              role: 'image',
              grant,
              mode: 'static',
              hasDocumentLinks: false,
            }
          : null,
      ),
    frameAncestors: () => [UI_ORIGIN],
    publicHost: PREVIEW_HOST,
    authorize: (incoming) => isConfiguredPerson(incoming, settings.login),
  });
});

afterAll(async () => {
  await ui.close();
  await preview.close();
  rmSync(webRoot, { recursive: true, force: true });
});

function send(
  port: number,
  path: string,
  options: {
    method?: string;
    host?: string;
    headers?: Record<string, string | string[]>;
    body?: string;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { Host: options.host ?? UI_HOST, ...options.headers },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    sent.on('error', reject);
    // Written before the end, so it goes chunked: the JSON check holds whatever the transfer encoding.
    if (options.body !== undefined) sent.write(options.body);
    sent.end();
  });
}

// The status of a GET with a second Host, written byte for byte (Node's client refuses a repeated Host).
function twoHosts(port: number, path: string, first: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${first}\r\nHost: other.example\r\nTailscale-User-Login: ${settings.login}\r\nConnection: close\r\n\r\n`,
      ),
    );
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0)));
    socket.on('error', reject);
  });
}

describe('phone reader: who may read', () => {
  it('only the configured person through the configured Host gets the list, stream, documents, screen, and files', async () => {
    const api = (path: string, who: Who) =>
      send(ui.port, `/_/mobile/v1${path}`, { headers: identity(who) });
    const file = (who: Who, method = 'GET') =>
      send(preview.port, FILE, { method, host: PREVIEW_HOST, headers: identity(who) });
    expect((await api('/documents', 'person')).status).toBe(200);
    expect((await file('person')).status).toBe(200);
    expect((await file('person', 'HEAD')).status).toBe(200);
    for (const who of ['other', 'none', 'twice'] as const) {
      expect((await api('/documents', who)).status, who).toBe(403);
      expect((await api('/events', who)).status, who).toBe(403);
      expect((await api('/documents/doc_1/content', who)).status, who).toBe(403);
      expect((await send(ui.port, '/', { headers: identity(who) })).status, who).toBe(403);
      // The preview answers like an unknown grant.
      expect((await file(who)).status, who).toBe(404);
      expect((await file(who, 'HEAD')).status, who).toBe(404);
    }

    // The configured Host only: not the local address, not another name, not without the port.
    for (const host of [`127.0.0.1:${String(ui.port)}`, 'other.example:43182', settings.host]) {
      const listed = await send(ui.port, '/_/mobile/v1/documents', {
        host,
        headers: identity('person'),
      });
      expect(listed.status, host).toBe(403);
    }
    const local = `127.0.0.1:${String(preview.port)}`;
    expect(
      (await send(preview.port, FILE, { host: local, headers: identity('person') })).status,
    ).toBe(404);
    // A second Host is ambiguous on both listeners, even when the first one is right.
    expect(await twoHosts(ui.port, '/_/mobile/v1/documents', UI_HOST)).toBe(403);
    expect(await twoHosts(preview.port, FILE, PREVIEW_HOST)).toBe(404);

    // A state change needs this screen's Origin from the same site, and exactly the JSON media type with valid JSON.
    const check = (headers: Record<string, string>, body = `{"grant":"${GRANT}"}`) =>
      send(ui.port, '/_/mobile/v1/render-grants/check', {
        method: 'POST',
        headers: { ...identity('person'), 'Content-Type': 'application/json', ...headers },
        body,
      });
    expect((await check({ Origin: UI_ORIGIN })).status).toBe(200);
    expect((await check({})).status).toBe(403);
    expect((await check({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await check({ Origin: UI_ORIGIN, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await check({ Origin: UI_ORIGIN, 'Content-Type': 'text/plain' })).status).toBe(400);
    const jsonp = await check({ Origin: UI_ORIGIN, 'Content-Type': 'application/jsonp' });
    expect(jsonp.status).toBe(400);
    expect((await check({ Origin: UI_ORIGIN }, '{"grant":')).status).toBe(400);
    const charset = await check({
      Origin: UI_ORIGIN,
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(charset.status).toBe(200);
  });

  it('offers no management routes and never serves the PC screen', async () => {
    const person = identity('person');
    expect(await send(ui.port, '/', { headers: person })).toEqual({
      status: 200,
      body: 'the phone screen',
    });
    expect((await send(ui.port, '/index.html', { headers: person })).status).toBe(404);
    for (const [method, path] of [
      ['DELETE', '/_/mobile/v1/documents/doc_1'],
      ['POST', '/_/mobile/v1/documents/doc_1/focus'],
      ['POST', '/_/mobile/v1/documents/doc_1/html-mode'],
      ['PUT', '/_/mobile/v1/documents/order'],
      ['GET', '/_/mobile/v1/feedback'],
      ['GET', '/_/api/v1/documents'],
      ['GET', '/_/api/v1/status'],
      ['POST', '/_/api/v1/documents/doc_1/focus'],
    ] as const) {
      const response = await send(ui.port, path, {
        method,
        headers: { ...person, Origin: UI_ORIGIN },
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});

function post(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('removing a document from the PC list', () => {
  it('reaches the PC close only by document ID, from this screen, as the person, with an empty JSON body', async () => {
    const closed: unknown[] = [];
    server = await startMobileServer(
      {
        daemonId: 'daemon_test',
        settings,
        webRoot: null,
        isOpen: () => true,
        isStopping: () => false,
        documents: {
          state: { catalogVersion: 1 },
          close: (input: unknown) => {
            closed.push(input);
            return Promise.resolve({});
          },
        },
      } as unknown as MobileDeps,
      { port: 0 },
    );
    const id = 'doc_00000000-0000-4000-8000-000000000001';
    const valid = {
      Host: `${settings.host}:43182`,
      'Tailscale-User-Login': settings.login,
      Origin: `https://${settings.host}:43182`,
      'Content-Type': 'application/json',
    };
    const refused: Array<[string, Record<string, string>, string, string]> = [
      ['another person', { ...valid, 'Tailscale-User-Login': 'other@example.com' }, '{}', id],
      ['another Host', { ...valid, Host: 'other.example:43182' }, '{}', id],
      ['no Origin', { ...valid, Origin: '' }, '{}', id],
      ['another Origin', { ...valid, Origin: 'https://evil.example' }, '{}', id],
      ['a cross-site fetch', { ...valid, 'Sec-Fetch-Site': 'cross-site' }, '{}', id],
      ['not JSON', { ...valid, 'Content-Type': 'text/plain' }, '{}', id],
      ['more than an empty object', valid, '{"all":true}', id],
      ['a path for the ID', valid, '{}', encodeURIComponent('/home/me/a.md')],
    ];
    for (const [why, headers, body, target] of refused) {
      const sent = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== ''));
      const status = await post(server.port, `/_/mobile/v1/documents/${target}/close`, sent, body);
      expect([why, status >= 400]).toEqual([why, true]);
    }
    expect(closed).toEqual([]);

    expect(await post(server.port, `/_/mobile/v1/documents/${id}/close`, valid, '{}')).toBe(200);
    expect(closed).toEqual([{ cwd: '/', targets: [id], all: false }]);
  });
});
