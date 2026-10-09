import { request as httpRequest } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestHome, type TestHome } from './harness.ts';

let t: TestHome;
let origin: string;

beforeEach(async () => {
  t = createTestHome();
  t.write('secret.md', '# 秘密の見出し\n\n秘密の本文\n');
  await t.run(['open', 'secret.md', '--json']);
  const status = (await t.run(['daemon', 'status', '--json'])).json<{ uiUrl: string }>();
  origin = status.data.uiUrl.replace(/\/$/, '');
});

afterEach(async () => {
  await t.cleanup();
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// Sends a request with arbitrary headers such as Host.
function raw(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

describe('management API without authentication', () => {
  it('reads the list and body directly, including after a daemon restart', async () => {
    const list = await raw('/_/api/v1/documents');
    expect(list.status).toBe(200);
    expect(list.body).toContain('秘密の見出し');
    const { data } = JSON.parse(list.body) as {
      data: { documents: Array<{ documentId: string }> };
    };
    const id = data.documents[0]?.documentId as string;
    const content = await raw(`/_/api/v1/documents/${id}/content`);
    expect(content.status).toBe(200);
    expect(content.body).toContain('秘密の本文');

    await t.run(['daemon', 'restart', '--json']);
    origin = (await t.run(['daemon', 'status', '--json']))
      .json<{ uiUrl: string }>()
      .data.uiUrl.replace(/\/$/, '');
    expect((await raw('/_/api/v1/documents')).status).toBe(200);
  });
});

describe('SEC-002 Origin and Host checks', () => {
  it('rejects an attacker Origin, Origin: null, and an aliased Host', async () => {
    const rejectedHeaders: Record<string, string>[] = [
      { Origin: 'http://attacker.example' },
      { Origin: 'null' },
      { Origin: origin.replace('127.0.0.1', 'localhost') },
      { Host: 'attacker.example' },
      { Host: `localhost:${new URL(origin).port}` },
      { 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of rejectedHeaders) {
      const response = await raw('/_/api/v1/documents', { headers });
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(response.body).not.toContain('秘密');
    }
    // With an aliased Host, the UI HTML is not returned either.
    expect((await raw('/', { headers: { Host: 'attacker.example' } })).status).toBe(401);
  });

  it('state-changing requests are limited to JSON from the UI origin', async () => {
    const list = JSON.parse((await raw('/_/api/v1/documents', { headers: {} })).body) as {
      data: { documents: Array<{ documentId: string }> };
    };
    const id = list.data.documents[0]?.documentId as string;

    // Rejects changes without Origin (equivalent to non-browser clients or form submissions).
    const noOrigin = await raw(`/_/api/v1/documents/${id}`, {
      method: 'DELETE',
      headers: {},
    });
    expect(noOrigin.status).toBe(401);
    const form = await raw('/_/api/v1/documents/order', {
      method: 'PUT',
      headers: {
        Origin: origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'order=x',
    });
    expect(form.status).toBe(400);
    // The document has not been closed.
    const after = await t.run(['list', '--json']);
    expect(after.json<{ totalDocuments: number }>().data.totalDocuments).toBe(1);
  });

  it('does not allow CORS, and does not answer unknown APIs with the UI HTML', async () => {
    const preflight = await raw('/_/api/v1/documents', {
      method: 'OPTIONS',
      headers: { Origin: 'http://attacker.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    const unknown = await raw('/_/api/v1/unknown', {
      headers: {},
    });
    expect(unknown.status).toBe(404);
    expect(unknown.headers['content-type']).toContain('application/json');
    const outside = await raw('/_/other');
    expect(outside.status).toBe(404);
    expect(outside.body).not.toContain('<html');
    expect((await raw('/not-a-page')).status).toBe(404);
  });
});

describe('DOC-008 saving the display order', () => {
  it('saves the reordering and keeps it after a restart; files are not moved', async () => {
    t.write('b.md', '# b\n');
    t.write('c.md', '# c\n');
    await t.run(['open', 'b.md', 'c.md', '--json']);
    const headers = {
      Origin: origin,
      'Content-Type': 'application/json',
    };
    const listed = JSON.parse((await raw('/_/api/v1/documents', { headers: {} })).body) as {
      data: { documents: Array<{ documentId: string; title: string }> };
      meta: { catalogVersion: number };
    };
    const ids = listed.data.documents.map((document) => document.documentId);
    const reversed = ids.toReversed();

    const reordered = await raw('/_/api/v1/documents/order', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ order: reversed, expectedCatalogVersion: listed.meta.catalogVersion }),
    });
    expect(reordered.status).toBe(200);
    const titlesOf = async () =>
      (await t.run(['list', '--json']))
        .json<{ documents: Array<{ title: string }> }>()
        .data.documents.map((document) => document.title);
    expect(await titlesOf()).toEqual(['c', 'b', '秘密の見出し']);

    // Rejects a reordering based on a stale list, and one with missing or extra documents.
    const stale = await raw('/_/api/v1/documents/order', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ order: ids, expectedCatalogVersion: listed.meta.catalogVersion }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toContain('E_CATALOG_CONFLICT');
    const partial = await raw('/_/api/v1/documents/order', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        order: ids.slice(1),
        expectedCatalogVersion: listed.meta.catalogVersion + 1,
      }),
    });
    expect(partial.status).toBe(400);

    await t.run(['daemon', 'restart', '--json']);
    expect(await titlesOf()).toEqual(['c', 'b', '秘密の見出し']);
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const name of ['secret.md', 'b.md', 'c.md'])
      expect(existsSync(join(t.work, name))).toBe(true);
  });
});

describe('reusable UI URL', () => {
  it('prints the same URL repeatedly without secrets or expiry warnings and supports JSON', async () => {
    const first = await t.run(['ui', '--print-url']);
    const second = await t.run(['ui', '--print-url']);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.trim()).toBe(`${origin}/`);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stderr).toBe('');
    const printed = await t.run(['ui', '--print-url', '--json']);
    expect(printed.exitCode).toBe(0);
    expect(printed.json<{ uiUrl: string; opened: boolean }>().data).toEqual({
      uiUrl: `${origin}/`,
      opened: false,
    });
    for (const [path, method] of [
      ['/sessions/bootstrap', 'POST'],
      ['/session', 'DELETE'],
    ]) {
      const response = await raw(`/_/api/v1${path}`, {
        method,
        headers: { Origin: origin, 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(404);
    }
  });
});

describe('SYS-013 (partial) change notifications', () => {
  it('SSE streams without authentication hello on connect and change notifications, without bodies', async () => {
    const response = await fetch(`${origin}/_/api/v1/events`, {
      headers: {},
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async (text: string) => {
      const deadline = Date.now() + 5000;
      while (!received.includes(text)) {
        if (Date.now() > deadline) throw new Error(`did not receive ${text}: ${received}`);
        // When the connection drops because the daemon stops, reading may end with an error.
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
    };
    await readUntil('event: hello');
    t.write('next.md', '# 通知の確認\n');
    await t.run(['open', 'next.md', '--json']);
    await readUntil('event: catalog-changed');
    await t.run(['daemon', 'stop', '--json']);
    await readUntil('event: daemon-stopping');
    expect(received).toContain('event: daemon-stopping');
    await reader.cancel().catch(() => undefined);

    expect(received).not.toContain('通知の確認');
    expect(received).not.toContain('秘密');
    const sequences = [...received.matchAll(/"sequence":(\d+)/g)].map((match) => Number(match[1]));
    expect(sequences).toEqual(sequences.toSorted((a, b) => a - b));
  });

  it('stopping the daemon ends the connected SSE', async () => {
    const response = await fetch(`${origin}/_/api/v1/events`, {
      headers: {},
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let received = '';
    let ended = false;
    const reading = (async () => {
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      ended = true;
    })();
    const deadline = Date.now() + 5000;
    while (!received.includes('event: hello')) {
      if (Date.now() > deadline) throw new Error('did not receive hello');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await t.run(['daemon', 'stop', '--json']);
    await Promise.race([
      reading,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('SSE does not end')), 5000),
      ),
    ]);
    expect(ended).toBe(true);

    expect(received).toContain('daemon-stopping');
  });
});
