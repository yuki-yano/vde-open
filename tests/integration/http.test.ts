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

// Hostなどのheaderを自由に指定してrequestを送る。
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

describe('SEC-001 管理APIの認証', () => {
  it('tokenなし・別のtokenでは、一覧も本文も返さない', async () => {
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

  it('正しいtokenでだけ読め、破棄したtokenと再起動前のtokenは使えない', async () => {
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

    // sessionはmemoryだけにあるので、daemonの再起動で失効する。
    const before = await session();
    await t.run(['daemon', 'restart', '--json']);
    const status = (await t.run(['daemon', 'status', '--json'])).json<{ uiUrl: string }>();
    origin = status.data.uiUrl.replace(/\/$/, '');
    expect(
      (await raw('/_/api/v1/documents', { headers: { Authorization: `Bearer ${before}` } })).status,
    ).toBe(401);
  });
});

describe('SEC-002 OriginとHostの検査', () => {
  it('攻撃者のOrigin、Origin: null、別名のHostを拒否する', async () => {
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
    // 別名のHostでは、UIのHTMLも返さない。
    expect((await raw('/', { headers: { Host: 'attacker.example' } })).status).toBe(401);
  });

  it('状態を変えるrequestは、UIのoriginからのJSONに限る', async () => {
    const token = await session();
    const list = JSON.parse(
      (await raw('/_/api/v1/documents', { headers: { Authorization: `Bearer ${token}` } })).body,
    ) as { data: { documents: Array<{ documentId: string }> } };
    const id = list.data.documents[0]?.documentId as string;

    // Originのない変更（browser以外やformの送信に相当）を拒否する。
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
    // 文書は閉じられていない。
    const after = await t.run(['list', '--json']);
    expect(after.json<{ totalDocuments: number }>().data.totalDocuments).toBe(1);
  });

  it('CORSを許可せず、未知のAPIをUIのHTMLで応答しない', async () => {
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

describe('DOC-008 表示順の保存', () => {
  it('並べ替えを保存し、再起動後も保つ。fileは動かさない', async () => {
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

    // 古い一覧にもとづく並べ替えと、文書の過不足がある並べ替えは拒否する。
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
  it('1回だけ交換でき、2回目と未知のticketは拒否する', async () => {
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
    // 別のoriginからは、正しいticketでも交換できない。
    const crossOrigin = await raw('/_/api/v1/sessions/bootstrap', {
      method: 'POST',
      headers: { Origin: 'http://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: await ticket() }),
    });
    expect(crossOrigin.status).toBe(401);
  });

  it('通常の結果やlogに、ticketやtokenを出さない', async () => {
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
    // 秘密を含むURLの表示は、--jsonと併用できない。
    const printed = await t.run(['ui', '--print-url', '--json']);
    expect(printed.exitCode).toBe(2);
    expect(printed.stdout).not.toContain('bootstrap=');
  });
});

describe('SYS-013（部分検証）更新通知', () => {
  it('認証したSSEは、接続時のhelloと変更の通知を、本文なしで流す', async () => {
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
        if (Date.now() > deadline) throw new Error(`${text} を受け取れませんでした: ${received}`);
        // daemonの停止で接続が切れると、読み取りはerrorで終わることがある。
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

  it('sessionを破棄すると、接続済みのSSEも終わり、その後の通知は届かない', async () => {
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
      if (Date.now() > deadline) throw new Error('helloを受け取れませんでした');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const revoked = await raw('/_/api/v1/session', {
      method: 'DELETE',
      headers: { Origin: origin, Authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(200);
    // 破棄した時点で、接続はserver側から閉じられる。
    await Promise.race([
      reading,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('SSEが終了しません')), 5000),
      ),
    ]);
    expect(ended).toBe(true);

    // その後の変更は、破棄したsessionの接続へ流れない。
    t.write('after-revoke.md', '# 破棄の後\n');
    await t.run(['open', 'after-revoke.md', '--json']);
    expect(received).not.toContain('catalog-changed');
  });
});
