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

async function ticket(): Promise<string> {
  const printed = await t.run(['ui', '--print-url']);
  return printed.stdout.trim().split('#bootstrap=')[1] as string;
}

async function session(): Promise<string> {
  const response = await raw('/_/api/v1/sessions/bootstrap', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: await ticket() }),
  });
  return (JSON.parse(response.body) as { data: { token: string } }).data.token;
}

const API_PATHS = ['/documents', '/status', '/events'];

describe('SEC-001 management API authentication', () => {
  it('returns neither the list nor the body without a token or with a different token', async () => {
    for (const path of API_PATHS) {
      const none = await raw(`/_/api/v1${path}`);
      expect(none.status, path).toBe(401);
      expect(none.body).not.toContain('秘密');
      const wrong = await raw(`/_/api/v1${path}`, {
        headers: { Authorization: `Bearer ${'x'.repeat(43)}` },
      });
      expect(wrong.status, path).toBe(401);
    }
  });

  it('readable only with the correct token; a revoked token and a token from before a restart are unusable', async () => {
    const token = await session();
    const authorized = { Authorization: `Bearer ${token}` };
    const list = await raw('/_/api/v1/documents', { headers: authorized });
    expect(list.status).toBe(200);
    expect(list.body).toContain('秘密の見出し');

    const revoked = await raw('/_/api/v1/session', {
      method: 'DELETE',
      headers: { ...authorized, Origin: origin },
    });
    expect(revoked.status).toBe(200);
    expect((await raw('/_/api/v1/documents', { headers: authorized })).status).toBe(401);

    // Sessions live only in memory, so they expire on daemon restart.
    const before = await session();
    await t.run(['daemon', 'restart', '--json']);
    const status = (await t.run(['daemon', 'status', '--json'])).json<{ uiUrl: string }>();
    origin = status.data.uiUrl.replace(/\/$/, '');
    expect(
      (await raw('/_/api/v1/documents', { headers: { Authorization: `Bearer ${before}` } })).status,
    ).toBe(401);
  });
});

describe('SEC-002 Origin and Host checks', () => {
  it('rejects an attacker Origin, Origin: null, and an aliased Host', async () => {
    const token = await session();
    const authorized = { Authorization: `Bearer ${token}` };
    for (const headers of [
      { ...authorized, Origin: 'http://attacker.example' },
      { ...authorized, Origin: 'null' },
      { ...authorized, Origin: origin.replace('127.0.0.1', 'localhost') },
      { ...authorized, Host: 'attacker.example' },
      { ...authorized, Host: `localhost:${new URL(origin).port}` },
      { ...authorized, 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const response = await raw('/_/api/v1/documents', { headers });
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(response.body).not.toContain('秘密');
    }
    // With an aliased Host, the UI HTML is not returned either.
    expect((await raw('/', { headers: { Host: 'attacker.example' } })).status).toBe(401);
  });

  it('state-changing requests are limited to JSON from the UI origin', async () => {
    const token = await session();
    const list = JSON.parse(
      (await raw('/_/api/v1/documents', { headers: { Authorization: `Bearer ${token}` } })).body,
    ) as { data: { documents: Array<{ documentId: string }> } };
    const id = list.data.documents[0]?.documentId as string;

    // Rejects changes without Origin (equivalent to non-browser clients or form submissions).
    const noOrigin = await raw(`/_/api/v1/documents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(noOrigin.status).toBe(401);
    const form = await raw('/_/api/v1/documents/order', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
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
    const token = await session();
    const preflight = await raw('/_/api/v1/documents', {
      method: 'OPTIONS',
      headers: { Origin: 'http://attacker.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    const unknown = await raw('/_/api/v1/unknown', {
      headers: { Authorization: `Bearer ${token}` },
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
    const token = await session();
    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: origin,
      'Content-Type': 'application/json',
    };
    const listed = JSON.parse(
      (await raw('/_/api/v1/documents', { headers: { Authorization: `Bearer ${token}` } })).body,
    ) as {
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

describe('SEC-003 bootstrap ticket', () => {
  it('can be exchanged once; a second exchange and an unknown ticket are rejected', async () => {
    const value = await ticket();
    const exchange = () =>
      raw('/_/api/v1/sessions/bootstrap', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: value }),
      });
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(401);

    const unknown = await raw('/_/api/v1/sessions/bootstrap', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 'x'.repeat(43) }),
    });
    expect(unknown.status).toBe(401);
    // From a different origin, even a correct ticket cannot be exchanged.
    const crossOrigin = await raw('/_/api/v1/sessions/bootstrap', {
      method: 'POST',
      headers: { Origin: 'http://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: await ticket() }),
    });
    expect(crossOrigin.status).toBe(401);
  });

  it('does not show the ticket or token in normal results or the log', async () => {
    const value = await ticket();
    const token = await session();
    const status = await t.run(['daemon', 'status', '--json']);
    const opened = await t.run(['open', 'secret.md', '--json']);
    await t.run(['daemon', 'stop', '--json']);
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const log = readFileSync(join(t.home, 'logs', 'daemon.jsonl'), 'utf8');
    for (const output of [status.stdout, opened.stdout, log]) {
      expect(output).not.toContain(value);
      expect(output).not.toContain(token);
      expect(output).not.toContain('bootstrap=');
    }
    // Printing the URL containing a secret cannot be combined with --json.
    const printed = await t.run(['ui', '--print-url', '--json']);
    expect(printed.exitCode).toBe(2);
    expect(printed.stdout).not.toContain('bootstrap=');
  });
});

describe('SYS-013 (partial) change notifications', () => {
  it('authenticated SSE streams hello on connect and change notifications, without bodies', async () => {
    const token = await session();
    const response = await fetch(`${origin}/_/api/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
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

  it('revoking the session also ends the connected SSE, and later notifications do not arrive', async () => {
    const token = await session();
    const response = await fetch(`${origin}/_/api/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
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

    const revoked = await raw('/_/api/v1/session', {
      method: 'DELETE',
      headers: { Origin: origin, Authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(200);
    // At revocation, the server closes the connection.
    await Promise.race([
      reading,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('SSE does not end')), 5000),
      ),
    ]);
    expect(ended).toBe(true);

    // Later changes do not flow to the revoked session's connection.
    t.write('after-revoke.md', '# 破棄の後\n');
    await t.run(['open', 'after-revoke.md', '--json']);
    expect(received).not.toContain('catalog-changed');
  });
});
