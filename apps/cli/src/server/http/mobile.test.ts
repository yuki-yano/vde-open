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
