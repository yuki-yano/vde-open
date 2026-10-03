import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestHome, type TestHome } from './harness.ts';

let t: TestHome;
let opener: string;
let opened: string;

beforeEach(() => {
  t = createTestHome();
  // An executable that does not open a real browser and only records the given URL to a file.
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

describe.skipIf(process.platform === 'win32')('SYS-002 / CLI-009 launching the browser', () => {
  it('opens the browser with --open, and the URL contains a one-time ticket', async () => {
    const first = await t.run(['open', 'a.md', '--open', '--json'], { env: { BROWSER: opener } });
    expect(first.exitCode).toBe(0);
    expect(first.json().warnings).toEqual([]);
    const urls = openedUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[A-Za-z0-9_-]+$/);
    // The URL containing a secret is not shown in the JSON result.
    expect(first.stdout).not.toContain('bootstrap=');

    // The second open uses the same daemon. Without --open, no tab is added.
    const daemonId = (await t.run(['daemon', 'status', '--json'])).json<{ daemonId: string }>().data
      .daemonId;
    await t.run(['open', 'b.md', '--json'], { env: { BROWSER: opener } });
    expect(openedUrls()).toHaveLength(1);
    expect(
      (await t.run(['daemon', 'status', '--json'])).json<{ daemonId: string }>().data.daemonId,
    ).toBe(daemonId);
  });

  it('when run from a terminal, opens the browser only the first time a new daemon starts, even without a flag', async () => {
    // No --open, --no-open, or --json. The browser opens by the default decision alone.
    const first = await t.runAsTerminal(['open', 'a.md'], opener);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('documents: 1 (new 1');
    const urls = openedUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[A-Za-z0-9_-]+$/);
    expect(first.stdout).not.toContain('bootstrap=');
    const daemonId = (await t.run(['daemon', 'status', '--json'])).json<{ daemonId: string }>().data
      .daemonId;

    // The second run adds to the running daemon. Even from a terminal, no tab is added.
    const second = await t.runAsTerminal(['open', 'b.md'], opener);
    expect(second.exitCode).toBe(0);
    expect(openedUrls()).toHaveLength(1);
    expect(
      (await t.run(['daemon', 'status', '--json'])).json<{ daemonId: string }>().data.daemonId,
    ).toBe(daemonId);

    // Even from a terminal, --json and --no-open do not open. --open opens even when already running.
    await t.runAsTerminal(['open', 'a.md', '--json'], opener);
    await t.runAsTerminal(['open', 'a.md', '--no-open'], opener);
    expect(openedUrls()).toHaveLength(1);
    await t.runAsTerminal(['open', 'a.md', '--open'], opener);
    expect(openedUrls()).toHaveLength(2);
  });

  it('when not run from a terminal, does not open the browser without a flag, even if a new daemon starts', async () => {
    const result = await t.run(['open', 'a.md'], { env: { BROWSER: opener } });
    expect(result.exitCode).toBe(0);
    expect(openedUrls()).toEqual([]);
  });

  it('with --json from a terminal, does not open the browser even if a new daemon starts', async () => {
    const result = await t.runAsTerminal(['open', 'a.md', '--json'], opener);
    expect(result.exitCode).toBe(0);
    expect(openedUrls()).toEqual([]);
  });

  it('treats the --open and --no-open conflict as an error only when given as options', async () => {
    // After `--`, arguments are file names, not options.
    t.write('--open', '# openという名前\n');
    t.write('--no-open', '# no-openという名前\n');
    const files = await t.run(
      ['open', '--format', 'markdown', '--json', '--', '--open', '--no-open'],
      { env: { BROWSER: opener } },
    );
    expect(files.exitCode).toBe(0);
    expect(files.json<{ documents: unknown[] }>().data.documents).toHaveLength(2);
    expect(openedUrls()).toEqual([]);

    // A string appearing as an option value is not counted as a flag either.
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

  it('does not open the browser with --json or --no-open', async () => {
    await t.run(['open', 'a.md', '--json'], { env: { BROWSER: opener } });
    await t.run(['open', 'b.md', '--no-open'], { env: { BROWSER: opener } });
    expect(openedUrls()).toEqual([]);
    const both = await t.run(['open', 'a.md', '--open', '--no-open', '--json']);
    expect(both.exitCode).toBe(2);
  });

  it('registration succeeds even if the browser cannot be opened, and the failure is shown separately as a warning', async () => {
    const result = await t.run(['open', 'a.md', '--open', '--json'], {
      env: { BROWSER: join(t.work, 'no-such-browser') },
    });
    expect(result.exitCode).toBe(0);
    const envelope = result.json<{ documents: unknown[] }>();
    expect(envelope.ok).toBe(true);
    expect(envelope.data.documents).toHaveLength(1);
    expect(envelope.warnings.map((warning) => warning.code)).toEqual(['W_BROWSER_OPEN_FAILED']);
    // stdout is exactly one JSON value. The URL containing a secret is not shown.
    expect(result.stdout).not.toContain('bootstrap=');

    const text = await t.run(['open', 'b.md', '--open'], {
      env: { BROWSER: join(t.work, 'no-such-browser') },
    });
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toContain('W_BROWSER_OPEN_FAILED');
    expect(text.stdout).toContain('documents: 1 (');
  });

  it('ui opens the browser, and --focus switches the shown document', async () => {
    await t.run(['open', 'a.md', 'b.md', '--json']);
    const ui = await t.run(['ui', '--json'], { env: { BROWSER: opener } });
    expect(ui.json<{ opened: boolean; uiUrl: string }>().data).toMatchObject({ opened: true });
    expect(openedUrls()).toHaveLength(1);

    // Running without arguments is the same as ui.
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

  it('the daemon does not stop when the browser is closed (no connections)', async () => {
    await t.run(['open', 'a.md', '--open', '--json'], { env: { BROWSER: opener } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await t.run(['daemon', 'status', '--json'])).json<{ state: string }>().data.state).toBe(
      'running',
    );
  });
});
