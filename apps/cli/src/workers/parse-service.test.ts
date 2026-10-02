import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

describe('解析worker', () => {
  it('文書の構造を解析して返す', async () => {
    service = createParseService();
    const analysis = await service.analyze('markdown', '# 概要\n\n## 手順\n');
    expect(analysis.title).toBe('概要');
    expect(analysis.outline.map((item) => item.title)).toEqual(['概要', '手順']);
    expect((await service.analyze('html', '<title>t</title><h1>見出し</h1>')).title).toBe('t');
  });

  it('MD-006: 構造の上限を超える文書は、解析errorにする', async () => {
    service = createParseService();
    await expect(service.analyze('markdown', `${'> '.repeat(70)}深い`)).rejects.toMatchObject({
      code: 'E_PARSE_FAILED',
      details: { reason: 'limit-depth' },
    });
    // errorの後も、同じworkerで解析を続けられる。
    expect((await service.analyze('markdown', '# 次\n')).title).toBe('次');
  });

  it('MD-006: 時間内に終わらない解析は、workerを止めて回収し、その後も解析できる', async () => {
    // 最初の依頼にだけ応答しないworker。作り直された後は、すぐに応答する。
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

  it('参照の収集と、表示用の変換も、workerで行う', async () => {
    service = createParseService();
    expect(
      await service.scan('html', '<img src="a.png"><link rel="stylesheet" href="s.css">'),
    ).toEqual([
      { url: 'a.png', context: 'image' },
      { url: 's.css', context: 'style' },
    ]);
    expect(await service.scan('css', '@import "b.css"; .a { background: url(c.png) }')).toEqual([
      { url: 'b.css', context: 'style' },
      { url: 'c.png', context: 'css-url' },
    ]);
    expect(
      await service.scan('markdown', '![図](img/a.png) ![外](https://e.example/b.png)'),
    ).toEqual([
      { url: 'img/a.png', context: 'image' },
      { url: 'https://e.example/b.png', context: 'image' },
    ]);

    const rendered = await service.render({
      format: 'html',
      source:
        '<link rel="stylesheet" href="s.css"><script>x()</script><img src="a.png"><p>本文</p>',
      documentLogicalPath: 'index.html',
      assets: [
        { logicalPath: 'a.png', role: 'image' },
        { logicalPath: 's.css', role: 'style' },
      ],
      stylesheets: [
        {
          logicalPath: 's.css',
          text: '.a{background:url(a.png)} .b{background:url(//e.example/x.png)}',
        },
      ],
    });
    expect(rendered.html).toContain('<img src="a.png">');
    expect(rendered.html).not.toContain('script');
    expect(rendered.stylesheets).toEqual([
      // 外部を参照する宣言だけが外れる。
      { logicalPath: 's.css', css: '.a{background:url(a.png)}.b{}' },
    ]);
    expect(rendered.diagnostics.map((entry) => entry.code).toSorted()).toEqual([
      'remote-asset-blocked',
      'script-removed',
    ]);
  });

  it('閉じた後は解析を受け付けない', async () => {
    service = createParseService();
    await service.close();
    await expect(service.analyze('markdown', '# x\n')).rejects.toMatchObject({
      code: 'E_DAEMON_STOPPING',
    });
  });
});
