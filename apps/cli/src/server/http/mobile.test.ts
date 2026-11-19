import { request } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { startMobileServer, type MobileDeps, type MobileServer } from './mobile.ts';

const settings = {
  host: 'example-mac.example-tailnet.ts.net',
  login: 'person@example.com',
  uiPort: 43182,
  previewPort: 43183,
};

let server: MobileServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function get(port: number, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: { Host: `${settings.host}:43182`, 'Tailscale-User-Login': settings.login },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('the phone screen before it is built', () => {
  it('answers / with its own 503, never the PC screen, and unknown paths with 404', async () => {
    // Only the static routes are reached here; the document services are not used.
    server = await startMobileServer(
      {
        daemonId: 'daemon_test',
        settings,
        webRoot: null,
        isOpen: () => true,
        isStopping: () => false,
      } as unknown as MobileDeps,
      { port: 0 },
    );
    const root = await get(server.port, '/');
    expect(root.status).toBe(503);
    expect(root.body).toBe('The phone reader UI has not been built. Run pnpm build.');
    expect((await get(server.port, '/index.html')).status).toBe(404);
    const api = await get(server.port, '/_/mobile/v1/unknown');
    expect(api.status).toBe(404);
    expect(api.type).toContain('application/json');
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
