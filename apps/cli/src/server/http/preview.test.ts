import { randomBytes } from 'node:crypto';
import { request, type IncomingHttpHeaders } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PreviewFile } from '../../render/render-service.ts';
import { startPreviewServer, type PreviewServer } from './preview.ts';

const GRANT = randomBytes(32).toString('base64url');
const MISSING = 'secret-path-name.png';

let server: PreviewServer;
let events: Array<{ event: string; fields: Record<string, string | number> }>;

beforeEach(async () => {
  events = [];
  server = await startPreviewServer({
    // Every path but one resolves, so a 404 comes from the listener's own checks.
    resolve: (grant, logicalPath): Promise<PreviewFile | null> => {
      if (logicalPath === MISSING) return Promise.resolve(null);
      const svg = logicalPath.endsWith('.svg');
      return Promise.resolve({
        body: Buffer.from(
          svg
            ? '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
            : '<p>Body</p>',
        ),
        mime: svg ? 'image/svg+xml' : 'text/html; charset=utf-8',
        role: svg ? 'svg' : 'document',
        grant,
        mode: 'static',
        hasDocumentLinks: false,
      });
    },
    frameAncestors: () => ['http://127.0.0.1:1'],
    onEvent: (event, fields) => events.push({ event, fields }),
  });
});

afterEach(async () => {
  await server.close();
});

function send(
  method: string,
  path: string,
  host = `127.0.0.1:${String(server.port)}`,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, method, path, headers: { Host: host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('SEC-014 / SEC-016 / SEC-017 the preview listener', () => {
  it('serves an SVG asset with headers that keep its scripts from running even when opened directly', async () => {
    const svg = await send('GET', `/r/${GRANT}/files/img.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    const csp = String(svg.headers['content-security-policy']).split('; ');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
    expect(csp.some((directive) => directive.startsWith('script-src'))).toBe(false);
  });

  it('answers only GET and HEAD for view URLs under its own Host, without redirects, and logs neither the grant nor the path', async () => {
    const files = `/r/${GRANT}/files/`;
    const get = await send('GET', `${files}index.html`);
    const head = await send('HEAD', `${files}index.html`);
    expect(get.status).toBe(200);
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(get.headers['content-length']);
    expect(head.headers['content-security-policy']).toBe(get.headers['content-security-policy']);
    // HEAD goes through the same lookup as GET.
    expect((await send('HEAD', `${files}${MISSING}`)).status).toBe(404);

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = await send(method, `${files}index.html`);
      expect(response.status, method).toBe(405);
      expect(response.headers['allow'], method).toBe('GET, HEAD');
    }

    for (const path of [
      '/',
      '/index.html',
      '/assets/index.js',
      '/_/api/v1/status',
      '/_/api/v1/documents',
      '/_/api/v1/sessions/bootstrap',
      '/r',
      '/r/',
      `/r/${GRANT}/`,
      `/r/${GRANT}`,
      files,
      `/r/${GRANT}/index.html`,
      '/favicon.ico',
    ]) {
      const response = await send('GET', path);
      expect(response.status, path).toBe(404);
      expect(response.headers['content-type'], path).toBe('text/plain; charset=utf-8');
      expect(response.headers['location'], path).toBeUndefined();
      expect(response.body, path).toBe('Not Found');
    }

    // A request carrying another name for this listener (DNS rebinding) is not answered.
    for (const host of ['attacker.example', `localhost:${String(server.port)}`]) {
      expect((await send('GET', `${files}index.html`, host)).status, host).toBe(404);
    }

    expect(events.map(({ event }) => event)).toEqual(
      expect.arrayContaining(['preview.served', 'preview.rejected']),
    );
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(GRANT);
    expect(logged).not.toContain('secret-path-name');
  });
});
