import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitDir, worktree } from '../../apps/cli/src/documents/git.fixture.ts';
import { cliEntry, createTestHome, fixture, type TestHome } from './harness.ts';

interface Summary {
  documentId: string;
  key: string | null;
  format: string;
  sourceKind: string;
  title: string;
  displayPath: string | null;
  canonicalPath: string | null;
  repository: unknown;
  revision: string;
  order: number;
}
interface OpenData {
  documents: Summary[];
  created: number;
  updated: number;
  unchanged: number;
}
interface ListData {
  documents: Summary[];
  totalDocuments: number;
  nextCursor: string | null;
}
interface ReadData {
  documentId: string;
  revision: string;
  content: string;
  truncated: boolean;
  nextCursor: string | null;
  sourceRange: { startByte: number; endByteExclusive: number; lineStart: number; lineEnd: number };
}

let t: TestHome;

beforeEach(() => {
  t = createTestHome();
});

afterEach(async () => {
  await t.cleanup();
});

async function listDocuments(): Promise<Summary[]> {
  return (await t.run(['list', '--json'])).json<ListData>().data.documents;
}

describe('CLI-003 listing and closing an opened document from another invocation', () => {
  it('operates on the same daemon and the same documentId', async () => {
    t.write('a.md', '# 一つ目\n');
    const opened = (await t.run(['open', 'a.md', '--json'])).json<OpenData>();
    expect(opened.ok).toBe(true);
    const documentId = opened.data.documents[0]?.documentId as string;
    const daemonId = (await t.run(['daemon', 'status', '--json'])).json<{ daemonId: string }>().data
      .daemonId;

    expect((await listDocuments()).map((document) => document.documentId)).toEqual([documentId]);
    const closed = (await t.run(['close', documentId, '--json'])).json<{ closed: string[] }>();
    expect(closed.data.closed).toEqual([documentId]);
    expect(await listDocuments()).toEqual([]);
    expect(
      (await t.run(['daemon', 'status', '--json'])).json<{ daemonId: string }>().data.daemonId,
    ).toBe(daemonId);
    // close does not delete the source file.
    expect(readFileSync(join(t.work, 'a.md'), 'utf8')).toBe('# 一つ目\n');
  });

  it('treats top-level file arguments as open', async () => {
    t.write('a.md', '# a\n');
    t.write('b.html', '<title>b</title>');
    const opened = (await t.run(['a.md', 'b.html', '--json'])).json<OpenData>();
    expect(opened.data.documents.map((document) => [document.title, document.format])).toEqual([
      ['a', 'markdown'],
      ['b', 'html'],
    ]);
  });
});

describe('CLI-004 20 concurrent opens', () => {
  it('one daemon, one entry for the same file, and the state is not corrupted', async () => {
    t.write('a.md', '# 同時\n');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => t.run(['open', 'a.md', '--json'])),
    );
    for (const result of results) expect(result.exitCode, result.stderr).toBe(0);
    const ids = new Set(
      results.map((result) => result.json<OpenData>().data.documents[0]?.documentId),
    );
    expect(ids.size).toBe(1);
    expect(await listDocuments()).toHaveLength(1);

    const log = readFileSync(join(t.home, 'logs', 'daemon.jsonl'), 'utf8');
    expect(log.match(/"event":"daemon\.started"/g)).toHaveLength(1);
    const doctor = (await t.run(['doctor', '--json'])).json<{
      state: { status: string };
      problems: unknown[];
    }>();
    expect(doctor.data.state.status).toBe('ok');
    expect(doctor.data.problems).toEqual([]);
  });
});

describe('CLI-005 special paths', () => {
  it('opens files with Japanese, spaces, a leading hyphen, or a subcommand name via explicit open and --', async () => {
    t.write('日本語 メモ.md', '# 日本語\n');
    t.write('-dash.md', '# dash\n');
    t.write('read', '# 同名\n');
    t.write('list.md', '# list\n');

    const japanese = await t.run(['日本語 メモ.md', '--json']);
    expect(japanese.json<OpenData>().data.documents[0]?.displayPath).toBe('日本語 メモ.md');

    const dash = await t.run(['open', '--json', '--', '-dash.md']);
    expect(dash.json<OpenData>().data.documents[0]?.title).toBe('dash');

    const sameName = await t.run(['--format', 'markdown', '--json', '--', 'read']);
    expect(sameName.json<OpenData>().data.documents[0]?.title).toBe('同名');
    const explicit = await t.run(['open', './read', '--format', 'markdown', '--json']);
    expect(explicit.json<OpenData>().data.unchanged).toBe(1);

    const listFile = await t.run(['open', 'list.md', '--json']);
    expect(listFile.json<OpenData>().data.documents[0]?.title).toBe('list');
    expect(await listDocuments()).toHaveLength(4);
  });

  it('opens the file even when an option value equals a subcommand name', async () => {
    t.write('a.md', '# a\n');
    const opened = (await t.run(['--title', 'read', 'a.md', '--json'])).json<OpenData>();
    expect(opened.data.documents[0]).toMatchObject({ title: 'read', displayPath: 'a.md' });
    const stdin = (
      await t.run(['--key', 'list', '--format', 'markdown', '--json'], { stdin: '# s\n' })
    ).json<OpenData>();
    expect(stdin.data.documents[0]?.key).toBe('list');
  });

  it('does not interpret as a shell string', async () => {
    const name = '$(touch pwned);`touch pwned2`&a.md';
    t.write(name, '# 安全\n');
    const opened = await t.run(['open', name, '--json']);
    expect(opened.json<OpenData>().data.documents[0]?.displayPath).toBe(name);
    expect(existsSync(join(t.work, 'pwned'))).toBe(false);
    expect(existsSync(join(t.work, 'pwned2'))).toBe(false);
  });
});

describe('CLI-006 registering from stdin', () => {
  it('registers with an explicit format, and updates the same ID for the same key', async () => {
    const first = (
      await t.run(['open', '-', '--format', 'markdown', '--key', 'review', '--json'], {
        stdin: '# レビュー 1\n',
      })
    ).json<OpenData>();
    expect(first.data).toMatchObject({ created: 1 });
    expect(first.data.documents[0]).toMatchObject({
      sourceKind: 'stdin',
      key: 'review',
      title: 'レビュー 1',
      displayPath: null,
    });

    // Even without arguments, opens from stdin when content is piped in.
    const second = (
      await t.run(['--format', 'markdown', '--key', 'review', '--json'], {
        stdin: '# レビュー 2\n',
      })
    ).json<OpenData>();
    expect(second.data).toMatchObject({ created: 0, updated: 1 });
    expect(second.data.documents[0]?.documentId).toBe(first.data.documents[0]?.documentId);
    expect(second.data.documents[0]?.revision).not.toBe(first.data.documents[0]?.revision);
    expect(second.data.documents[0]?.title).toBe('レビュー 2');

    // Without a key, each invocation creates a new document.
    await t.run(['open', '-', '--format', 'markdown', '--json'], { stdin: '# 無名\n' });
    await t.run(['open', '-', '--format', 'markdown', '--json'], { stdin: '# 無名\n' });
    expect(await listDocuments()).toHaveLength(3);
  });

  it('reads to EOF before registering, and does not return success with partial content', () => {
    // With a real pipe, write the content in two delayed parts.
    const script = `(printf '# 前半'; sleep 0.4; printf 'と後半\\n本文\\n') | "$NODE" "$CLI" open - --format markdown --json`;
    const stdout = execFileSync('sh', ['-c', script], {
      cwd: t.work,
      env: { ...process.env, VDE_OPEN_HOME: t.home, NODE: process.execPath, CLI: cliEntry },
      encoding: 'utf8',
    });
    const opened = JSON.parse(stdout) as { data: OpenData };
    expect(opened.data.documents[0]?.title).toBe('前半と後半');
  });
});

describe('CLI-007 wrong stdin usage', () => {
  it('stdin without a format exits 2 and registers nothing', async () => {
    const result = await t.run(['open', '-', '--json'], { stdin: '# x\n' });
    expect(result.exitCode).toBe(2);
    expect(result.json().error.code).toBe('E_INVALID_ARGUMENT');
    expect(await listDocuments()).toEqual([]);
  });

  it('combining a path with stdin exits 2 and registers nothing', async () => {
    t.write('a.md', '# a\n');
    const piped = await t.run(['open', 'a.md', '--json'], { stdin: '# x\n' });
    expect(piped.exitCode).toBe(2);
    expect(piped.json().error.code).toBe('E_INVALID_ARGUMENT');

    const explicit = await t.run(['open', '-', 'a.md', '--format', 'markdown', '--json'], {
      stdin: '# x\n',
    });
    expect(explicit.exitCode).toBe(2);
    expect(await listDocuments()).toEqual([]);
  });
});

describe('CLI-008 unknown extension', () => {
  it('rejects with auto, and registers only when the format is explicit', async () => {
    t.write('notes.txt', '# メモ\n');
    const auto = await t.run(['open', 'notes.txt', '--json']);
    expect(auto.exitCode).toBe(2);
    expect(auto.json().error.code).toBe('E_UNSUPPORTED_FORMAT');
    expect(await listDocuments()).toEqual([]);

    const explicit = (
      await t.run(['open', 'notes.txt', '--format', 'markdown', '--json'])
    ).json<OpenData>();
    expect(explicit.data.documents[0]).toMatchObject({ format: 'markdown', title: 'メモ' });
  });
});

describe('CLI-008 format check of arguments removed as duplicates', () => {
  it('rejects an unknown-extension argument pointing to the same file, regardless of argument order', async () => {
    const real = t.write('a.md', '# a\n');
    symlinkSync(real, join(t.work, 'alias.txt'));

    for (const paths of [
      ['a.md', 'alias.txt'],
      ['alias.txt', 'a.md'],
    ]) {
      const result = await t.run(['open', ...paths, '--json']);
      expect(result.exitCode, paths.join(' ')).toBe(2);
      expect(result.json().error).toMatchObject({
        code: 'E_UNSUPPORTED_FORMAT',
        details: { problems: [{ path: 'alias.txt', reason: 'unknown-extension' }] },
      });
      expect(await listDocuments()).toEqual([]);
    }

    // With an explicit format, it opens as one document.
    const explicit = (
      await t.run(['open', 'a.md', 'alias.txt', '--format', 'markdown', '--json'])
    ).json<OpenData>();
    expect(explicit.data.documents).toHaveLength(1);
    expect(explicit.data).toMatchObject({ created: 1 });
  });
});

describe('CLI-010 removed options', () => {
  it.each([
    ['--target', 'x'],
    ['--tag', 'y'],
    ['--workspace', 'z'],
  ])('%s is an error rather than ignored, and registers nothing', async (option, value) => {
    t.write('a.md', '# a\n');
    const result = await t.run(['open', 'a.md', option, value, '--json']);
    expect(result.exitCode).toBe(2);
    expect(result.json().error.code).toBe('E_INVALID_ARGUMENT');
    expect(result.stderr).toContain(option);
    // Does not start a stopped daemon just for this error.
    expect((await t.run(['daemon', 'status', '--json'])).json<{ state: string }>().data.state).toBe(
      'stopped',
    );
  });
});

describe('CLI-011 some of several arguments cannot be opened', () => {
  it('registers nothing if one does not exist', async () => {
    t.write('a.md', '# a\n');
    t.write('b.md', '# b\n');
    const result = await t.run(['open', 'a.md', 'missing.md', 'b.md', '--json']);
    expect(result.exitCode).toBe(3);
    expect(result.json().error).toMatchObject({
      code: 'E_PATH_NOT_FOUND',
      details: { path: 'missing.md' },
    });
    expect(await listDocuments()).toEqual([]);
  });

  it('registers nothing if one exceeds the size limit', async () => {
    t.write('a.md', '# a\n');
    t.write('huge.md', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    const result = await t.run(['open', 'a.md', 'huge.md', '--json']);
    expect(result.exitCode).toBe(7);
    const error = result.json().error;
    expect(error.code).toBe('E_LIMIT_EXCEEDED');
    expect(error.details['problems']).toEqual([
      { path: 'huge.md', code: 'E_LIMIT_EXCEEDED', reason: 'documentBytes' },
    ]);
    expect(await listDocuments()).toEqual([]);
  });
});

describe('duplicate arguments and the document count limit', () => {
  it('opens as one document even when the same file is given more times than the limit', async () => {
    t.write('a.md', '# a\n');
    const args = ['open', ...Array.from({ length: 2001 }, () => 'a.md'), '--json'];
    const opened = (await t.run(args)).json<OpenData>();
    expect(opened.data).toMatchObject({ created: 1 });
    expect(opened.data.documents).toHaveLength(1);
  });

  it('counts one per document even when directory, glob, and direct arguments overlap', async () => {
    t.write('docs/a.md', '# a\n');
    t.write('docs/b.md', '# b\n');
    t.write('docs/notes.txt', '# メモ\n');
    const opened = (
      await t.run(['open', 'docs', 'docs/*.md', 'docs/a.md', 'docs/b.md', '--json'])
    ).json<OpenData>();
    expect(opened.data.documents.map((document) => document.title)).toEqual(['a', 'b']);
    expect(opened.data).toMatchObject({ created: 2 });
  });
});

describe('more documents than the limit', () => {
  it('rejects by count before reading, and registers nothing', async () => {
    for (let index = 0; index < 2001; index += 1) {
      t.write(`many/${String(index).padStart(4, '0')}.md`, `# ${String(index)}\n`);
    }
    const result = await t.run(['open', 'many', '--json']);
    expect(result.exitCode).toBe(7);
    expect(result.json().error).toMatchObject({
      code: 'E_LIMIT_EXCEEDED',
      details: { limit: 'openDocuments', max: 2000, actual: 2001 },
    });
    expect(await listDocuments()).toEqual([]);
  });
});

describe('CLI-012 key conflict', () => {
  it('rejects another file taking the same key, and keeps the original document', async () => {
    t.write('a.md', '# a\n');
    t.write('b.md', '# b\n');
    const first = (await t.run(['open', 'a.md', '--key', 'k', '--json'])).json<OpenData>();
    const conflict = await t.run(['open', 'b.md', '--key', 'k', '--json']);
    expect(conflict.exitCode).toBe(4);
    expect(conflict.json().error.code).toBe('E_KEY_CONFLICT');

    const stdinConflict = await t.run(
      ['open', '-', '--format', 'markdown', '--key', 'k', '--json'],
      {
        stdin: '# 横取り\n',
      },
    );
    expect(stdinConflict.exitCode).toBe(4);

    const documents = await listDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      documentId: first.data.documents[0]?.documentId,
      key: 'k',
      title: 'a',
      revision: first.data.documents[0]?.revision,
    });
  });
});

describe('CLI-016 title and path with control characters', () => {
  it('escapes the output instead of letting terminal controls run', async () => {
    // Windows does not allow control characters in file names, so only the title and text carry them there.
    const pathHasControls = process.platform !== 'win32';
    const name = pathHasControls ? 'bad\u001b[31mname.md' : 'badname.md';
    const shownName = pathHasControls ? 'bad\\u001b[31mname.md' : 'badname.md';
    t.write(name, '# \u001b]0;乗っ取り\u0007 \u009b31m 見出し\n');
    const json = await t.run(['open', name, '--title', 'x\u001b[2Jy', '--json']);
    expect(json.exitCode).toBe(0);
    // The JSON is one line and contains no raw control characters (other than the newline).
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(json.stdout)).toBe(false);
    expect(json.json<OpenData>().data.documents[0]?.title).toBe('x\u001b[2Jy');

    const text = await t.run(['list']);
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text.stdout)).toBe(false);
    expect(text.stdout).toContain('x\\u001b[2Jy');
    expect(text.stdout).toContain(shownName);
  });
});

describe('DOC-001 duplicate registration of the same file', () => {
  it('stays one entry when opened twice or through a symlink', async () => {
    const real = t.write('docs/a.md', '# a\n');
    symlinkSync(real, join(t.work, 'link.md'));
    const first = (await t.run(['open', 'docs/a.md', '--json'])).json<OpenData>();
    const again = (await t.run(['open', 'docs/a.md', '--json'])).json<OpenData>();
    const viaLink = (await t.run(['open', 'link.md', '--json'])).json<OpenData>();
    const sameBatch = (await t.run(['open', 'docs/a.md', 'link.md', '--json'])).json<OpenData>();

    const id = first.data.documents[0]?.documentId;
    expect(again.data).toMatchObject({ created: 0, unchanged: 1 });
    expect(viaLink.data.documents[0]?.documentId).toBe(id);
    expect(sameBatch.data.documents).toHaveLength(1);
    expect(await listDocuments()).toHaveLength(1);
  });
});

describe('DOC-002 retargeting an explicitly given symlink', () => {
  it('does not read the new target automatically, and registers it only on reopen', async () => {
    const first = t.write('one.md', '# 一つ目\n');
    const second = t.write('two.md', '# 二つ目\n');
    const link = join(t.work, 'current.md');
    symlinkSync(first, link);
    const opened = (await t.run(['open', 'current.md', '--json'])).json<OpenData>();
    const firstId = opened.data.documents[0]?.documentId as string;

    unlinkSync(link);
    symlinkSync(second, link);
    const read = (await t.run(['read', firstId, '--json'])).json<ReadData>();
    expect(read.data.content).toBe('# 一つ目\n');
    expect(await listDocuments()).toHaveLength(1);

    const reopened = (await t.run(['open', 'current.md', '--json'])).json<OpenData>();
    expect(reopened.data.documents[0]?.documentId).not.toBe(firstId);
    expect((await listDocuments()).map((document) => document.title)).toEqual(['一つ目', '二つ目']);
  });
});

describe('DOC-003 directories and globs', () => {
  beforeEach(() => {
    t.write('docs/a.md', '# a\n');
    t.write('docs/b.html', '<title>b</title>');
    t.write('docs/notes.txt', 'x');
    t.write('docs/.hidden.md', '# hidden\n');
    t.write('docs/sub/c.md', '# c\n');
    t.write('docs/sub/deep/d.markdown', '# d\n');
    t.write('docs/node_modules/pkg/e.md', '# e\n');
    t.write('docs/.git/f.md', '# f\n');
    t.write('outside/g.md', '# g\n');
    symlinkSync(join(t.work, 'outside'), join(t.work, 'docs', 'linked-dir'));
    symlinkSync(join(t.work, 'outside', 'g.md'), join(t.work, 'docs', 'linked.md'));
  });

  const titles = async (args: string[]) =>
    (await t.run([...args, '--json'])).json<OpenData>().data.documents.map((d) => d.title);

  it('a directory means direct children only, -R recurses; hidden files, excluded directories, and symlinks are skipped', async () => {
    expect(await titles(['open', 'docs'])).toEqual(['a', 'b']);
    expect(await titles(['open', 'docs', '-R'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a quoted glob is itself a recursive specification', async () => {
    expect(await titles(['open', 'docs/**/*.md'])).toEqual(['a', 'c']);
    expect(await titles(['open', 'docs/*.html'])).toEqual(['b']);
  });

  it('errors without registering when nothing matches', async () => {
    t.write('empty/x.txt', 'x');
    const result = await t.run(['open', 'empty', '--json']);
    expect(result.exitCode).toBe(3);
    expect(result.json().error.code).toBe('E_PATH_NOT_FOUND');
  });
});

describe('DOC-015 unreadable kinds of input', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects FIFOs and devices without blocking',
    async () => {
      execFileSync('mkfifo', [join(t.work, 'pipe.md')]);
      const startedAt = Date.now();
      const fifo = await t.run(['open', 'pipe.md', '--json']);
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(fifo.exitCode).toBe(2);
      expect(fifo.json().error).toMatchObject({
        code: 'E_INVALID_SOURCE',
        details: { problems: [{ reason: 'not-a-regular-file' }] },
      });

      const device = await t.run(['open', '/dev/null', '--format', 'markdown', '--json']);
      expect(device.exitCode).toBe(2);
      expect(await listDocuments()).toEqual([]);
    },
  );

  it('rejects binary, NUL, and invalid UTF-8, and does not modify the source file', async () => {
    const nul = Buffer.from('# 見出し\n\u0000本文\n', 'utf8');
    const invalid = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
    t.write('nul.md', nul);
    t.write('invalid.md', invalid);
    for (const [name, reason] of [
      ['nul.md', 'contains-nul'],
      ['invalid.md', 'invalid-utf8'],
    ] as const) {
      const result = await t.run(['open', name, '--json']);
      expect(result.exitCode).toBe(2);
      expect(result.json().error.details['problems']).toEqual([
        { path: name, code: 'E_INVALID_SOURCE', reason },
      ]);
    }
    expect(readFileSync(join(t.work, 'nul.md')).equals(nul)).toBe(true);
    expect(readFileSync(join(t.work, 'invalid.md')).equals(invalid)).toBe(true);
    expect(await listDocuments()).toEqual([]);

    const stdin = await t.run(['open', '-', '--format', 'markdown', '--json'], { stdin: invalid });
    expect(stdin.exitCode).toBe(2);
  });
});

describe('read and close', () => {
  it('reads the source, a line range, and a revision, and continues with a cursor under a small limit', async () => {
    const source = fixture('auth.md');
    t.write('auth.md', source);
    const opened = (await t.run(['open', 'auth.md', '--json'])).json<OpenData>();
    const { documentId, revision } = opened.data.documents[0] as Summary;

    const whole = (await t.run(['read', documentId, '--json'])).json<ReadData>();
    expect(whole.data.content).toBe(source.toString('utf8'));
    expect(whole.data).toMatchObject({ revision, truncated: false, nextCursor: null });

    const lines = (await t.run(['read', documentId, '--lines', '6:8', '--json'])).json<ReadData>();
    expect(lines.data.content).toBe(
      '## セッションの有効期限\n\nセッションは最終操作から30分で失効する。\n',
    );
    expect(lines.data.sourceRange).toMatchObject({ lineStart: 6, lineEnd: 8 });

    // Read through with the minimum limit; joined, it reproduces the source.
    let cursor: string | null = null;
    let joined = '';
    for (let step = 0; step < 100; step += 1) {
      const args = ['read', documentId, '--max-bytes', '256', '--json'];
      if (cursor) args.push('--cursor', cursor);
      const part = (await t.run(args)).json<ReadData>();
      expect(Buffer.byteLength(part.data.content)).toBeLessThanOrEqual(256);
      joined += part.data.content;
      cursor = part.data.nextCursor;
      if (!cursor) break;
    }
    expect(joined).toBe(source.toString('utf8'));

    const tooSmall = await t.run(['read', documentId, '--max-bytes', '255', '--json']);
    expect(tooSmall.exitCode).toBe(2);
    expect(tooSmall.json().error.code).toBe('E_INVALID_ARGUMENT');
  });

  it('returns the requested revision after an update, and does not substitute the current revision for an unretained one', async () => {
    const path = t.write('a.md', '# 版1\n');
    const first = (await t.run(['open', 'a.md', '--json'])).json<OpenData>().data
      .documents[0] as Summary;
    renameSync(t.write('a.tmp', '# 版2\n'), path);
    const second = (await t.run(['open', 'a.md', '--json'])).json<OpenData>();
    // The watcher may publish the new revision before this open does (seen on slower CI runners),
    // so check the resulting revision rather than which of them updated it.
    const reopened = second.data.documents[0] as Summary;
    expect(reopened.documentId).toBe(first.documentId);
    expect(reopened.revision).not.toBe(first.revision);

    const old = (
      await t.run(['read', first.documentId, '--revision', first.revision, '--json'])
    ).json<ReadData>();
    expect(old.data.content).toBe('# 版1\n');
    const current = (await t.run(['read', first.documentId, '--json'])).json<ReadData>();
    expect(current.data.content).toBe('# 版2\n');

    const unknown = await t.run([
      'read',
      first.documentId,
      '--revision',
      `rev_${'0'.repeat(64)}`,
      '--json',
    ]);
    expect(unknown.exitCode).toBe(4);
    expect(unknown.json().error.code).toBe('E_REVISION_UNAVAILABLE');
  });

  it('a closed document cannot be read, close is idempotent, and an unknown ID is not found', async () => {
    t.write('a.md', '# a\n');
    t.write('b.md', '# b\n');
    const opened = (await t.run(['open', 'a.md', 'b.md', '--json'])).json<OpenData>();
    const [a, b] = opened.data.documents as [Summary, Summary];

    expect(
      (await t.run(['close', 'a.md', '--json'])).json<{ closed: string[] }>().data.closed,
    ).toEqual([a.documentId]);
    const again = (await t.run(['close', a.documentId, '--json'])).json<{
      closed: string[];
      alreadyClosed: string[];
    }>();
    expect(again.data).toEqual({ closed: [], alreadyClosed: [a.documentId] });

    const read = await t.run(['read', a.documentId, '--json']);
    expect(read.exitCode).toBe(3);
    expect(read.json().error.code).toBe('E_DOCUMENT_NOT_OPEN');

    const unknown = await t.run([
      'close',
      'doc_00000000-0000-4000-8000-000000000000',
      b.documentId,
      '--json',
    ]);
    expect(unknown.exitCode).toBe(3);
    // If even one cannot be resolved, none is closed.
    expect((await listDocuments()).map((document) => document.documentId)).toEqual([b.documentId]);

    // Reopening reuses the same ID.
    const reopened = (await t.run(['open', 'a.md', '--json'])).json<OpenData>();
    expect(reopened.data.documents[0]?.documentId).toBe(a.documentId);
    await t.run(['close', '--all', '--json']);
    expect(await listDocuments()).toEqual([]);
  });

  it('close by path does not confuse same-named files in different cwds', async () => {
    t.write('one/a.md', '# 一つ目\n');
    t.write('two/a.md', '# 二つ目\n');
    const one = join(t.work, 'one');
    const two = join(t.work, 'two');
    const first = (await t.run(['open', 'a.md', '--json'], { cwd: one })).json<OpenData>();
    const second = (await t.run(['open', 'a.md', '--json'], { cwd: two })).json<OpenData>();

    const closed = (await t.run(['close', 'a.md', '--json'], { cwd: two })).json<{
      closed: string[];
    }>();
    expect(closed.data.closed).toEqual([second.data.documents[0]?.documentId]);
    expect((await listDocuments()).map((document) => document.documentId)).toEqual([
      first.data.documents[0]?.documentId,
    ]);

    // An unregistered path is not found even if a same-named document exists.
    t.write('three/a.md', '# 三つ目\n');
    const unknown = await t.run(['close', 'a.md', '--json'], { cwd: join(t.work, 'three') });
    expect(unknown.exitCode).toBe(3);

    // A deleted file can still be closed by the path used at registration.
    unlinkSync(join(one, 'a.md'));
    const removed = (await t.run(['close', 'a.md', '--json'], { cwd: one })).json<{
      closed: string[];
    }>();
    expect(removed.data.closed).toEqual([first.data.documents[0]?.documentId]);
  });

  it('the list continues with limit and cursor, and the cursor becomes unusable when the list changes', async () => {
    for (const name of ['a', 'b', 'c']) t.write(`${name}.md`, `# ${name}\n`);
    await t.run(['open', 'a.md', 'b.md', 'c.md', '--json']);
    const first = (await t.run(['list', '--limit', '2', '--json'])).json<ListData>();
    expect(first.data.documents.map((d) => d.title)).toEqual(['a', 'b']);
    expect(first.data.totalDocuments).toBe(3);
    const cursor = first.data.nextCursor as string;

    const second = (
      await t.run(['list', '--limit', '2', '--cursor', cursor, '--json'])
    ).json<ListData>();
    expect(second.data.documents.map((d) => d.title)).toEqual(['c']);
    expect(second.data.nextCursor).toBeNull();

    const tampered = await t.run(['list', '--cursor', `${cursor}x`, '--json']);
    expect(tampered.exitCode).toBe(4);
    expect(tampered.json().error.code).toBe('E_INVALID_CURSOR');

    await t.run(['close', 'a.md', '--json']);
    const stale = await t.run(['list', '--cursor', cursor, '--json']);
    expect(stale.exitCode).toBe(4);
    expect(stale.json().error.code).toBe('E_CURSOR_STALE');
  });
});

describe('DOC-017 the repository of each document', () => {
  it('is shown by list, for a repository, a worktree with relative paths, and a file outside', async () => {
    const work = realpathSync(t.work);
    const repo = join(work, 'repo');
    gitDir(join(repo, '.git'));
    const checkout = join(repo, '.git', 'wt', 'feature', 'x');
    worktree(join(repo, '.git'), checkout, 'x', {
      head: 'ref: refs/heads/feature/x\n',
      relativePaths: true,
    });
    t.write('repo/docs/a.md', '# a\n');
    t.write('repo/.git/wt/feature/x/b.md', '# b\n');
    t.write('notes/c.md', '# c\n');
    await t.run(['open', 'repo/docs/a.md', 'repo/.git/wt/feature/x/b.md', 'notes/c.md', '--json']);

    const segments = (path: string) => path.split(sep).filter((part) => part !== '');
    expect(
      (await listDocuments()).map(({ canonicalPath, repository }) => ({
        canonicalPath,
        repository,
      })),
    ).toEqual([
      {
        canonicalPath: join(repo, 'docs', 'a.md'),
        repository: {
          state: 'resolved',
          id: join(repo, '.git'),
          nameSegments: segments(repo),
          checkout: { id: repo, kind: 'main' },
          pathInCheckout: ['docs', 'a.md'],
        },
      },
      {
        canonicalPath: join(checkout, 'b.md'),
        repository: {
          state: 'resolved',
          id: join(repo, '.git'),
          nameSegments: segments(repo),
          checkout: { id: checkout, kind: 'linked', name: 'x', branch: 'feature/x' },
          pathInCheckout: ['b.md'],
        },
      },
      { canonicalPath: join(work, 'notes', 'c.md'), repository: null },
    ]);
  });

  // Windows has no O_NOFOLLOW; the type is checked before opening instead. This runs on the Windows CI too.
  it('does not follow a symlinked HEAD', async (context) => {
    const work = realpathSync(t.work);
    gitDir(join(work, 'repo', '.git'));
    t.write('elsewhere/HEAD', 'ref: refs/heads/main\n');
    unlinkSync(join(work, 'repo', '.git', 'HEAD'));
    try {
      symlinkSync(join(work, 'elsewhere', 'HEAD'), join(work, 'repo', '.git', 'HEAD'));
    } catch {
      // Creating a symlink needs a privilege on Windows.
      context.skip();
    }
    t.write('repo/a.md', '# a\n');
    await t.run(['open', 'repo/a.md', '--json']);

    expect((await listDocuments())[0]?.repository).toMatchObject({
      state: 'unresolved',
      reason: 'invalid-git-dir',
    });
  });

  it('is in the first list after a restart, including a missing document', async () => {
    const work = realpathSync(t.work);
    gitDir(join(work, 'repo', '.git'));
    t.write('repo/a.md', '# a\n');
    t.write('repo/gone/b.md', '# b\n');
    await t.run(['open', 'repo/a.md', 'repo/gone/b.md', '--json']);
    await t.run(['daemon', 'stop', '--json']);
    unlinkSync(join(work, 'repo', 'gone', 'b.md'));

    // list starts a new daemon, which detects repositories before it accepts requests.
    expect((await listDocuments()).map((document) => document.repository)).toMatchObject([
      { state: 'resolved', id: join(work, 'repo', '.git'), pathInCheckout: ['a.md'] },
      { state: 'resolved', id: join(work, 'repo', '.git'), pathInCheckout: ['gone', 'b.md'] },
    ]);
  });
});
