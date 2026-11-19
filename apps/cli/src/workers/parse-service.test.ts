import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COLLECT_AFTER_IDLE_MS } from '../diagnostics/idle-collect.ts';

import { createParseService, type ParseService } from './parse-service.ts';

let dir: string;
let service: ParseService | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vde-open-parse-'));
  service = null;
});

afterEach(async () => {
  await service?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('parse worker', () => {
  it('MD-006: a document over the structure limit is a parse error', async () => {
    service = createParseService();
    await expect(service.analyze('markdown', `${'> '.repeat(70)}深い`)).rejects.toMatchObject({
      code: 'E_PARSE_FAILED',
      details: { reason: 'limit-depth' },
    });
    // Parsing continues on the same worker after the error, for either format.
    expect((await service.analyze('markdown', '# 次\n')).title).toBe('次');
    expect((await service.analyze('html', '<title>t</title><h1>見出し</h1>')).title).toBe('t');
  });

  it('MD-006: a parse that does not finish in time stops and reclaims the worker, and parsing still works afterwards', async () => {
    // A worker that ignores only the first request. After being recreated, it replies immediately.
    const marker = join(dir, 'started');
    const workerPath = join(dir, 'slow-worker.mjs');
    writeFileSync(
      workerPath,
      `import { existsSync, writeFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
const first = !existsSync(${JSON.stringify(marker)});
writeFileSync(${JSON.stringify(marker)}, '');
parentPort.on('message', (request) => {
  if (first) { for (;;) {} }
  parentPort.postMessage({ id: request.id, ok: true, result: { title: 'recovered', outline: [] } });
});
`,
    );
    service = createParseService({ timeoutMs: 200, workerPath });
    const startedAt = Date.now();
    await expect(service.analyze('markdown', '# 終わらない\n')).rejects.toMatchObject({
      code: 'E_PARSE_FAILED',
      details: { reason: 'timeout' },
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect((await service.analyze('markdown', '# 次\n')).title).toBe('recovered');
  });

  it('also collects references and transforms for display on the worker', async () => {
    service = createParseService();
    expect(await service.scan('markdown', '![図](img/a.png)')).toEqual([
      { url: 'img/a.png', context: 'image' },
    ]);
    const rendered = await service.render({
      format: 'html',
      source: '<p>本文</p>',
      documentLogicalPath: 'index.html',
      assets: [],
      mode: 'static',
      sdkScript: null,
      stylesheets: [],
    });
    expect(rendered.html).toContain('<p>本文</p>');
  });

  it('asks the worker to collect garbage once after parse requests pause', async () => {
    // A worker that reports how many times it was asked to collect as its heap.
    const workerPath = join(dir, 'counting-worker.mjs');
    writeFileSync(
      workerPath,
      `import { parentPort } from 'node:worker_threads';
let collects = 0;
parentPort.on('message', (request) => {
  if (request.op === 'collect') collects += 1;
  const result = request.op === 'diagnostics' ? { heapUsedBytes: collects, retained: {} } : { title: 't', outline: [] };
  parentPort.postMessage({ id: request.id, ok: true, result });
});
`,
    );
    service = createParseService({ workerPath });
    const collects = async () => (await service?.diagnostics(false))?.heapUsedBytes;
    await service.analyze('markdown', '# a\n');
    await service.analyze('markdown', '# b\n');
    expect(await collects()).toBe(0);
    await vi.waitFor(async () => expect(await collects()).toBe(1), { timeout: 5000 });
    // Diagnostics alone do not count as activity.
    await new Promise((resolve) => setTimeout(resolve, COLLECT_AFTER_IDLE_MS + 500));
    expect(await collects()).toBe(1);
  });

  it('does not accept parses after close', async () => {
    service = createParseService();
    await service.close();
    await expect(service.analyze('markdown', '# x\n')).rejects.toMatchObject({
      code: 'E_DAEMON_STOPPING',
    });
  });
});
