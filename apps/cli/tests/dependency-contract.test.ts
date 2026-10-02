// 導入した版のHono、MiniSearch、Chokidar、tinyglobby、Node 24のIntl.Segmenterについて、
// この製品が前提にするAPIと挙動を固定する。版を上げたらここで差分を検出する。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { type FSWatcher, watch } from 'chokidar';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import MiniSearch from 'minisearch';
import { glob } from 'tinyglobby';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'vde-open-contract-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('hono 4.13.12 + @hono/node-server 2.1.3', () => {
  it('OSが割り当てたportで127.0.0.1だけにlistenし、SSEを返せる', async () => {
    const app = new Hono();
    app.get('/events', (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: 'hello', data: '{"sequence":1}' });
      }),
    );
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      expect(address.port).toBeGreaterThan(0);

      const response = await fetch(`http://127.0.0.1:${String(address.port)}/events`);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(await response.text()).toBe('event: hello\ndata: {"sequence":1}\n\n');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('minisearch 7.2.0', () => {
  it('tokenizerを差し替え、field boostと文書の破棄ができる', () => {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    const tokenize = (text: string) =>
      Array.from(segmenter.segment(text))
        .filter((part) => part.isWordLike)
        .map((part) => part.segment);
    const index = new MiniSearch<{ id: string; title: string; body: string }>({
      fields: ['title', 'body'],
      tokenize,
      searchOptions: { boost: { title: 5 }, combineWith: 'AND' },
    });
    index.addAll([
      { id: 'a', title: '認証仕様', body: 'セッションは30分で失効する。' },
      { id: 'b', title: '設計メモ', body: '認証の方式を比較する。' },
    ]);
    expect(index.search('認証').map((hit) => hit.id)).toEqual(['a', 'b']);

    index.discard('a');
    expect(index.search('認証').map((hit) => hit.id)).toEqual(['b']);
  });
});

describe('Node 24のIntl.Segmenter', () => {
  it('日本語を語の単位に分割できる', () => {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    const words = Array.from(segmenter.segment('セッションの有効期限を更新する'))
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
    expect(words).toContain('セッション');
    expect(words).toContain('有効');
    expect(words).toContain('期限');
  });
});

describe('tinyglobby 0.2.17', () => {
  it('**で再帰列挙し、ignoreとdotfile除外が効く', async () => {
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

// 待機1回の期限。test全体の期限は、3回分の待機とwatcherの後始末が収まる長さにする。
const EVENT_TIMEOUT_MS = 4000;
const WATCH_TEST_TIMEOUT_MS = 20_000;

// 期限とerrorで必ず決着させ、成否にかかわらずlistenerを外す。
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
      reject(new Error(`${eventName} を期限内に検知できませんでした`));
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

// 監視を始めた直後の変更は、通知されないことがある（macOSで約35回に1回観測）。
// 通知されるまで内容を変えて書き直し、後続の変更で検知できることを確かめる。
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
    'directoryの監視で、fileの追加と変更を検知できる',
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
            (attempt) => `# a\n\n更新 ${String(attempt)}\n`,
          ),
        ).resolves.toBeUndefined();
      } finally {
        await watcher.close();
      }
    },
  );
});
