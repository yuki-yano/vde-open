import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cliEntry, createTestHome, fixture, type TestHome } from './harness.ts';

interface Summary {
  documentId: string;
  key: string | null;
  format: string;
  sourceKind: string;
  title: string;
  displayPath: string | null;
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

describe('CLI-003 開いた文書を別の呼び出しから一覧・closeする', () => {
  it('同じdaemonと同じdocumentIdを操作する', async () => {
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
    // closeは原本を削除しない。
    expect(readFileSync(join(t.work, 'a.md'), 'utf8')).toBe('# 一つ目\n');
  });

  it('最上位のfile引数はopenとして扱う', async () => {
    t.write('a.md', '# a\n');
    t.write('b.html', '<title>b</title>');
    const opened = (await t.run(['a.md', 'b.html', '--json'])).json<OpenData>();
    expect(opened.data.documents.map((document) => [document.title, document.format])).toEqual([
      ['a', 'markdown'],
      ['b', 'html'],
    ]);
  });
});

describe('CLI-004 同時に20回open', () => {
  it('daemonは1つで、同じfileは1件、stateは壊れない', async () => {
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

describe('CLI-005 特殊なpath', () => {
  it('日本語・空白・先頭ハイフン・subcommandと同名のfileを、明示openと--で開ける', async () => {
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

  it('optionの値がsubcommandと同じ文字列でも、fileを開く', async () => {
    t.write('a.md', '# a\n');
    const opened = (await t.run(['--title', 'read', 'a.md', '--json'])).json<OpenData>();
    expect(opened.data.documents[0]).toMatchObject({ title: 'read', displayPath: 'a.md' });
    const stdin = (
      await t.run(['--key', 'list', '--format', 'markdown', '--json'], { stdin: '# s\n' })
    ).json<OpenData>();
    expect(stdin.data.documents[0]?.key).toBe('list');
  });

  it('shellの文字列として解釈しない', async () => {
    const name = '$(touch pwned);`touch pwned2`&a.md';
    t.write(name, '# 安全\n');
    const opened = await t.run(['open', name, '--json']);
    expect(opened.json<OpenData>().data.documents[0]?.displayPath).toBe(name);
    expect(existsSync(join(t.work, 'pwned'))).toBe(false);
    expect(existsSync(join(t.work, 'pwned2'))).toBe(false);
  });
});

describe('CLI-006 stdinからの登録', () => {
  it('format指定で登録し、同じkeyなら同じIDを更新する', async () => {
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

    // 引数なしでも、stdinに内容が渡されていればstdinから開く。
    const second = (
      await t.run(['--format', 'markdown', '--key', 'review', '--json'], {
        stdin: '# レビュー 2\n',
      })
    ).json<OpenData>();
    expect(second.data).toMatchObject({ created: 0, updated: 1 });
    expect(second.data.documents[0]?.documentId).toBe(first.data.documents[0]?.documentId);
    expect(second.data.documents[0]?.revision).not.toBe(first.data.documents[0]?.revision);
    expect(second.data.documents[0]?.title).toBe('レビュー 2');

    // keyがなければ、呼び出しごとに新しい文書になる。
    await t.run(['open', '-', '--format', 'markdown', '--json'], { stdin: '# 無名\n' });
    await t.run(['open', '-', '--format', 'markdown', '--json'], { stdin: '# 無名\n' });
    expect(await listDocuments()).toHaveLength(3);
  });

  it('EOFまで読み切ってから登録し、途中の内容で成功を返さない', () => {
    // 本物のpipeで、内容を2回に分けて遅れて書く。
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

describe('CLI-007 stdinの誤った指定', () => {
  it('formatなしのstdinはexit 2で、何も登録しない', async () => {
    const result = await t.run(['open', '-', '--json'], { stdin: '# x\n' });
    expect(result.exitCode).toBe(2);
    expect(result.json().error.code).toBe('E_INVALID_ARGUMENT');
    expect(await listDocuments()).toEqual([]);
  });

  it('pathとstdinの併用はexit 2で、何も登録しない', async () => {
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

describe('CLI-008 不明な拡張子', () => {
  it('autoでは拒否し、形式を明示したときだけ登録する', async () => {
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

describe('CLI-008 重複として除かれる指定の形式検査', () => {
  it('同じfileを指す未知拡張子の指定は、指定の順序によらず拒否する', async () => {
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

    // 形式を明示すれば、1件の文書として開ける。
    const explicit = (
      await t.run(['open', 'a.md', 'alias.txt', '--format', 'markdown', '--json'])
    ).json<OpenData>();
    expect(explicit.data.documents).toHaveLength(1);
    expect(explicit.data).toMatchObject({ created: 1 });
  });
});

describe('CLI-010 削除済みのoption', () => {
  it.each([
    ['--target', 'x'],
    ['--tag', 'y'],
    ['--workspace', 'z'],
  ])('%s は無視せずerrorにし、何も登録しない', async (option, value) => {
    t.write('a.md', '# a\n');
    const result = await t.run(['open', 'a.md', option, value, '--json']);
    expect(result.exitCode).toBe(2);
    expect(result.json().error.code).toBe('E_INVALID_ARGUMENT');
    expect(result.stderr).toContain(option);
    // 起動していないdaemonを、このerrorのために起動しない。
    expect((await t.run(['daemon', 'status', '--json'])).json<{ state: string }>().data.state).toBe(
      'stopped',
    );
  });
});

describe('CLI-011 複数指定の一部が開けない', () => {
  it('1件が存在しなければ、全体を登録しない', async () => {
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

  it('1件が大きさの上限を超えれば、全体を登録しない', async () => {
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

describe('重複する指定と文書数の上限', () => {
  it('同じfileを上限より多く指定しても、1件の文書として開ける', async () => {
    t.write('a.md', '# a\n');
    const args = ['open', ...Array.from({ length: 2001 }, () => 'a.md'), '--json'];
    const opened = (await t.run(args)).json<OpenData>();
    expect(opened.data).toMatchObject({ created: 1 });
    expect(opened.data.documents).toHaveLength(1);
  });

  it('directory・glob・直接の指定が重なっても、文書ごとに1件として数える', async () => {
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

describe('上限を超える数の文書', () => {
  it('読み込む前に件数で拒否し、何も登録しない', async () => {
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

describe('CLI-012 keyの衝突', () => {
  it('別のfileが同じkeyを取ろうとしたら拒否し、元の文書を保つ', async () => {
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

describe('CLI-016 制御文字を含むtitleとpath', () => {
  it('端末制御を実行させず、escapeして出力する', async () => {
    const name = 'bad\u001b[31mname.md';
    t.write(name, '# \u001b]0;乗っ取り\u0007 \u009b31m 見出し\n');
    const json = await t.run(['open', name, '--title', 'x\u001b[2Jy', '--json']);
    expect(json.exitCode).toBe(0);
    // JSONは1行で、生の制御文字（改行以外）を含まない。
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(json.stdout)).toBe(false);
    expect(json.json<OpenData>().data.documents[0]?.title).toBe('x\u001b[2Jy');

    const text = await t.run(['list']);
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text.stdout)).toBe(false);
    expect(text.stdout).toContain('x\\u001b[2Jy');
    expect(text.stdout).toContain('bad\\u001b[31mname.md');
  });
});

describe('DOC-001 同じfileの重複登録', () => {
  it('2回開いても、symlink経由で開いても、1件のまま', async () => {
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

describe('DOC-002 明示したsymlinkの付け替え', () => {
  it('新しいtargetを自動では読まず、開き直したときだけ登録する', async () => {
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

describe('DOC-003 directoryとglob', () => {
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

  it('directoryは直下だけ、-Rは再帰。隠し・除外directory・symlinkは対象外', async () => {
    expect(await titles(['open', 'docs'])).toEqual(['a', 'b']);
    expect(await titles(['open', 'docs', '-R'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('quoteしたglobは、それ自体が再帰の指定になる', async () => {
    expect(await titles(['open', 'docs/**/*.md'])).toEqual(['a', 'c']);
    expect(await titles(['open', 'docs/*.html'])).toEqual(['b']);
  });

  it('対象が1件もなければ登録せずerrorにする', async () => {
    t.write('empty/x.txt', 'x');
    const result = await t.run(['open', 'empty', '--json']);
    expect(result.exitCode).toBe(3);
    expect(result.json().error.code).toBe('E_PATH_NOT_FOUND');
  });
});

describe('DOC-015 読めない種類の入力', () => {
  it.skipIf(process.platform === 'win32')('FIFOやdeviceは待たされずに拒否する', async () => {
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
  });

  it('binary、NUL、不正なUTF-8を拒否し、原本を変更しない', async () => {
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

describe('readとclose', () => {
  it('原文・行範囲・版を指定して取得し、小さい上限ではcursorで続きを取得する', async () => {
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

    // 最小の上限で読み進め、つなぐと原文に戻る。
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

  it('更新後も指定した版を返し、保持していない版を現在の版で代用しない', async () => {
    const path = t.write('a.md', '# 版1\n');
    const first = (await t.run(['open', 'a.md', '--json'])).json<OpenData>().data
      .documents[0] as Summary;
    renameSync(t.write('a.tmp', '# 版2\n'), path);
    const second = (await t.run(['open', 'a.md', '--json'])).json<OpenData>();
    expect(second.data).toMatchObject({ updated: 1 });

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

  it('閉じた文書は読めず、closeは冪等で、未知のIDはnot found', async () => {
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
    // 1件でも解決できなければ、どれも閉じない。
    expect((await listDocuments()).map((document) => document.documentId)).toEqual([b.documentId]);

    // 開き直すと同じIDを再利用する。
    const reopened = (await t.run(['open', 'a.md', '--json'])).json<OpenData>();
    expect(reopened.data.documents[0]?.documentId).toBe(a.documentId);
    await t.run(['close', '--all', '--json']);
    expect(await listDocuments()).toEqual([]);
  });

  it('pathでのcloseは、cwdが違う同名のfileを取り違えない', async () => {
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

    // 登録していないpathは、同名の文書があってもnot found。
    t.write('three/a.md', '# 三つ目\n');
    const unknown = await t.run(['close', 'a.md', '--json'], { cwd: join(t.work, 'three') });
    expect(unknown.exitCode).toBe(3);

    // 削除済みのfileも、登録時と同じpathで閉じられる。
    unlinkSync(join(one, 'a.md'));
    const removed = (await t.run(['close', 'a.md', '--json'], { cwd: one })).json<{
      closed: string[];
    }>();
    expect(removed.data.closed).toEqual([first.data.documents[0]?.documentId]);
  });

  it('一覧はlimitとcursorで続きを取得でき、一覧が変わるとcursorは使えない', async () => {
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
