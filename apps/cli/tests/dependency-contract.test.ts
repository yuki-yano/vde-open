// Pins the APIs and behavior this product relies on in the installed versions of Hono, Chokidar,
// and tinyglobby. Upgrading a version surfaces differences here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { type FSWatcher, watch } from 'chokidar';
import { Hono } from 'hono';
import { glob } from 'tinyglobby';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'vde-open-contract-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('hono 4.13.19 + @hono/node-server 2.1.9', () => {
  it('listens only on 127.0.0.1 on an OS-assigned port', async () => {
    const server = serve({ fetch: new Hono().fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      expect(address.port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('tinyglobby 0.2.17', () => {
  it('enumerates recursively with ** and honors ignore and dotfile exclusion', async () => {
    mkdirSync(join(workDir, 'docs', 'sub'), { recursive: true });
    mkdirSync(join(workDir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(workDir, 'docs', 'a.md'), '# a\n');
    writeFileSync(join(workDir, 'docs', 'sub', 'b.md'), '# b\n');
    writeFileSync(join(workDir, 'docs', '.hidden.md'), '# hidden\n');
    writeFileSync(join(workDir, 'node_modules', 'x', 'c.md'), '# c\n');

    const found = await glob('**/*.md', {
      cwd: workDir,
      ignore: ['**/node_modules/**'],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    expect(found.toSorted()).toEqual(['docs/a.md', 'docs/sub/b.md']);
  });
});

// Deadline for one wait. The whole test's deadline fits three waits plus the watcher cleanup.
const EVENT_TIMEOUT_MS = 4000;
const WATCH_TEST_TIMEOUT_MS = 20_000;

// Always settle on the deadline or an error, and remove the listeners either way.
function waitForEvent(
  watcher: FSWatcher,
  eventName: 'ready' | 'add' | 'change',
  targetPath?: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      watcher.off('all', onAll);
      watcher.off('ready', onReady);
      watcher.off('error', onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${eventName} was not detected before the deadline`));
    }, EVENT_TIMEOUT_MS);
    const onAll = (event: string, path: string) => {
      if (event !== eventName || path !== targetPath) return;
      cleanup();
      resolve();
    };
    const onReady = () => {
      if (eventName !== 'ready') return;
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    watcher.on('all', onAll);
    watcher.on('ready', onReady);
    watcher.on('error', onError);
  });
}

// A change right after watching starts is sometimes not reported (observed about 1 in 35 times on macOS).
// Rewrite the content until it is reported, then check that later changes are detected.
async function writeUntilEvent(
  watcher: FSWatcher,
  eventName: 'add' | 'change',
  targetPath: string,
  content: (attempt: number) => string,
): Promise<void> {
  const seen = waitForEvent(watcher, eventName, targetPath);
  let attempt = 0;
  writeFileSync(targetPath, content(attempt));
  const timer = setInterval(() => {
    attempt += 1;
    writeFileSync(targetPath, content(attempt));
  }, 250);
  try {
    await seen;
  } finally {
    clearInterval(timer);
  }
}

describe('chokidar 5.0.0', () => {
  it(
    'detects added and changed files when watching a directory',
    { timeout: WATCH_TEST_TIMEOUT_MS },
    async () => {
      const target = join(workDir, 'a.md');
      const watcher = watch(workDir, { ignoreInitial: true, depth: 0 });
      try {
        await waitForEvent(watcher, 'ready');
        await expect(
          writeUntilEvent(watcher, 'add', target, (attempt) => `# a ${String(attempt)}\n`),
        ).resolves.toBeUndefined();
        await expect(
          writeUntilEvent(
            watcher,
            'change',
            target,
            (attempt) => `# a\n\nupdate ${String(attempt)}\n`,
          ),
        ).resolves.toBeUndefined();
      } finally {
        await watcher.close();
      }
    },
  );
});
