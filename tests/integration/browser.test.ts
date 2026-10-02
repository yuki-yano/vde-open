import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestHome, type TestHome } from './harness.ts';

let t: TestHome;
let opener: string;
let opened: string;

beforeEach(() => {
  t = createTestHome();
  // 本物のbrowserを開かず、渡されたURLをfileへ記録するだけの実行file。
  opened = join(t.work, 'opened-urls.txt');
  opener = join(t.work, 'fake-browser.sh');
  writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${opened}"\n`);
  chmodSync(opener, 0o755);
  t.write('a.md', '# a\n');
  t.write('b.md', '# b\n');
});

afterEach(async () => {
  await t.cleanup();
});

const openedUrls = () =>
  existsSync(opened) ? readFileSync(opened, 'utf8').trim().split('\n') : [];

describe.skipIf(process.platform === 'win32')('SYS-002 / CLI-009 browserの起動', () => {
  it('--openでbrowserを開き、URLは一回限りのticketを含む', async () => {
    const first = await t.run(['open', 'a.md', '--open', '--json'], { env: { BROWSER: opener } });
    expect(first.exitCode).toBe(0);
    expect(first.json().warnings).toEqual([]);
    const urls = openedUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[A-Za-z0-9_-]+$/);
    // 秘密を含むURLは、JSONの結果には出さない。
    expect(first.stdout).not.toContain('bootstrap=');

    // 2回目のopenは同じdaemonを使う。--openを付けなければ、tabを増やさない。
    const daemonId = (await t.run(['daemon', 'status', '--json'])).json<{ daemonId: string }>().data
      .daemonId;
    await t.run(['open', 'b.md', '--json'], { env: { BROWSER: opener } });
    expect(openedUrls()).toHaveLength(1);
    expect(
      (await t.run(['daemon', 'status', '--json'])).json<{ daemonId: string }>().data.daemonId,
    ).toBe(daemonId);
  });

  it('端末からの実行では、指定がなくても、daemonを新しく起動した初回だけbrowserを開く', async () => {
    // --open・--no-open・--jsonを付けない。既定の判定だけでbrowserを開く。
    const first = await t.runAsTerminal(['open', 'a.md'], opener);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('1件');
    const urls = openedUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[A-Za-z0-9_-]+$/);
    expect(first.stdout).not.toContain('bootstrap=');
    const daemonId = (await t.run(['daemon', 'status', '--json'])).json<{ daemonId: string }>().data
      .daemonId;

    // 2回目は起動済みのdaemonへの追加。端末からの実行でも、tabを増やさない。
    const second = await t.runAsTerminal(['open', 'b.md'], opener);
    expect(second.exitCode).toBe(0);
    expect(openedUrls()).toHaveLength(1);
    expect(
      (await t.run(['daemon', 'status', '--json'])).json<{ daemonId: string }>().data.daemonId,
    ).toBe(daemonId);

    // 端末からでも、--jsonと--no-openは開かない。--openは起動済みでも開く。
    await t.runAsTerminal(['open', 'a.md', '--json'], opener);
    await t.runAsTerminal(['open', 'a.md', '--no-open'], opener);
    expect(openedUrls()).toHaveLength(1);
    await t.runAsTerminal(['open', 'a.md', '--open'], opener);
    expect(openedUrls()).toHaveLength(2);
  });

  it('端末でない実行では、daemonを新しく起動しても、指定がなければbrowserを開かない', async () => {
    const result = await t.run(['open', 'a.md'], { env: { BROWSER: opener } });
    expect(result.exitCode).toBe(0);
    expect(openedUrls()).toEqual([]);
  });

  it('端末からの--jsonでは、daemonを新しく起動してもbrowserを開かない', async () => {
    const result = await t.runAsTerminal(['open', 'a.md', '--json'], opener);
    expect(result.exitCode).toBe(0);
    expect(openedUrls()).toEqual([]);
  });

  it('--openと--no-openの競合は、optionとして指定されたときだけerrorにする', async () => {
    // `--`より後は、optionではなくfile名。
    t.write('--open', '# openという名前\n');
    t.write('--no-open', '# no-openという名前\n');
    const files = await t.run(
      ['open', '--format', 'markdown', '--json', '--', '--open', '--no-open'],
      { env: { BROWSER: opener } },
    );
    expect(files.exitCode).toBe(0);
    expect(files.json<{ documents: unknown[] }>().data.documents).toHaveLength(2);
    expect(openedUrls()).toEqual([]);

    // optionの値として現れる文字列も、flagとして数えない。
    const value = await t.run(['open', 'a.md', '--title', '--no-open', '--open', '--json'], {
      env: { BROWSER: opener },
    });
    expect(value.exitCode).toBe(0);
    expect(value.json<{ documents: Array<{ title: string }> }>().data.documents[0]?.title).toBe(
      '--no-open',
    );
    expect(openedUrls()).toHaveLength(1);

    const both = await t.run(['open', 'a.md', '--open', '--no-open', '--json']);
    expect(both.exitCode).toBe(2);
    expect(both.json().error.code).toBe('E_INVALID_ARGUMENT');
  });

  it('--jsonと--no-openでは、browserを開かない', async () => {
    await t.run(['open', 'a.md', '--json'], { env: { BROWSER: opener } });
    await t.run(['open', 'b.md', '--no-open'], { env: { BROWSER: opener } });
    expect(openedUrls()).toEqual([]);
    const both = await t.run(['open', 'a.md', '--open', '--no-open', '--json']);
    expect(both.exitCode).toBe(2);
  });

  it('browserを開けなくても登録は成功し、失敗はwarningとして別に示す', async () => {
    const result = await t.run(['open', 'a.md', '--open', '--json'], {
      env: { BROWSER: join(t.work, 'no-such-browser') },
    });
    expect(result.exitCode).toBe(0);
    const envelope = result.json<{ documents: unknown[] }>();
    expect(envelope.ok).toBe(true);
    expect(envelope.data.documents).toHaveLength(1);
    expect(envelope.warnings.map((warning) => warning.code)).toEqual(['W_BROWSER_OPEN_FAILED']);
    // stdoutはJSON 1個だけ。秘密を含むURLは出さない。
    expect(result.stdout).not.toContain('bootstrap=');

    const text = await t.run(['open', 'b.md', '--open'], {
      env: { BROWSER: join(t.work, 'no-such-browser') },
    });
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toContain('W_BROWSER_OPEN_FAILED');
    expect(text.stdout).toContain('1件');
  });

  it('uiはbrowserを開き、--focusは表示する文書を切り替える', async () => {
    await t.run(['open', 'a.md', 'b.md', '--json']);
    const ui = await t.run(['ui', '--json'], { env: { BROWSER: opener } });
    expect(ui.json<{ opened: boolean; uiUrl: string }>().data).toMatchObject({ opened: true });
    expect(openedUrls()).toHaveLength(1);

    // 引数なしの実行は、uiと同じ。
    await t.run([], { env: { BROWSER: opener } });
    expect(openedUrls()).toHaveLength(2);

    const focused = (await t.run(['open', 'b.md', '--focus', '--json'])).json<{
      documents: Array<{ documentId: string }>;
    }>();
    const state = JSON.parse(readFileSync(join(t.home, 'state.json'), 'utf8')) as {
      payload: { activeDocumentId: string };
    };
    expect(state.payload.activeDocumentId).toBe(focused.data.documents[0]?.documentId);
  });

  it('browserを閉じても（接続がなくても）、daemonは止まらない', async () => {
    await t.run(['open', 'a.md', '--open', '--json'], { env: { BROWSER: opener } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await t.run(['daemon', 'status', '--json'])).json<{ state: string }>().data.state).toBe(
      'running',
    );
  });
});
