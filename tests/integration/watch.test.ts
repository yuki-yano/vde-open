import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestHome, type TestHome } from './harness.ts';

interface Summary {
  documentId: string;
  title: string;
  revision: string;
  sourceState: string;
  displayPath: string | null;
}
interface WatchRule {
  watchId: string;
  kind: string;
  suppressedPaths: string[];
}

let t: TestHome;

beforeEach(() => {
  t = createTestHome();
});

afterEach(async () => {
  await t.cleanup();
});

const list = async () =>
  (await t.run(['list', '--json'])).json<{ documents: Summary[] }>().data.documents;
const rules = async () =>
  (await t.run(['watch', 'list', '--json'])).json<{ watchRules: WatchRule[] }>().data.watchRules;

// 監視による反映を待つ。条件を満たすまで一覧を取り直す。
async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const titles = (documents: Summary[]) => documents.map((document) => document.title).toSorted();

describe('DOC-004 更新の追従と、--watchでの新しい文書の登録', () => {
  it('通常のopenでも、そのfileの更新を追う', async () => {
    const path = t.write('a.md', '# 版1\n');
    const before = (await t.run(['open', 'a.md', '--json'])).json<{ documents: Summary[] }>().data
      .documents[0] as Summary;
    writeFileSync(path, '# 版2\n');
    const after = await waitFor(
      list,
      (documents) => documents[0]?.title === '版2',
      '更新が反映されない',
    );
    expect(after[0]?.documentId).toBe(before.documentId);
    expect(after[0]?.revision).not.toBe(before.revision);
    // --watchを付けていないので、同じdirectoryの新しいfileは登録しない。
    t.write('b.md', '# 追加\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(titles(await list())).toEqual(['版2']);
  });

  it('--watchを付けたdirectoryに現れた文書だけを登録する', async () => {
    t.write('docs/a.md', '# a\n');
    const opened = (await t.run(['open', 'docs', '--watch', '--json'])).json<{
      documents: Summary[];
      watchRules: WatchRule[];
    }>();
    expect(opened.data.watchRules).toHaveLength(1);
    expect(opened.data.watchRules[0]?.kind).toBe('directory');

    t.write('docs/b.md', '# b\n');
    t.write('docs/c.html', '<title>c</title>');
    t.write('docs/notes.txt', 'x');
    t.write('docs/.hidden.md', '# hidden\n');
    t.write('docs/sub/d.md', '# d\n');
    await waitFor(list, (documents) => documents.length === 3, '新しい文書が登録されない');
    await new Promise((resolve) => setTimeout(resolve, 500));
    // 対象の拡張子だけ。隠しfileと、再帰していないdirectoryの下は対象外。
    expect(titles(await list())).toEqual(['a', 'b', 'c']);
  });

  it('globの--watchは、patternに合う新しい文書を登録する', async () => {
    t.write('notes/x.md', '# x\n');
    await t.run(['open', 'notes/**/*.md', '--watch', '--json']);
    t.write('notes/deep/y.md', '# y\n');
    t.write('notes/deep/z.html', '<title>z</title>');
    await waitFor(list, (documents) => documents.length === 2, 'globの対象が登録されない');
    expect(titles(await list())).toEqual(['x', 'y']);
  });

  it('対象がまだ無いdirectoryでも、--watchでruleを登録できる', async () => {
    mkdirSync(join(t.work, 'empty'));
    const opened = await t.run(['open', 'empty', '--watch', '--json']);
    expect(opened.exitCode).toBe(0);
    t.write('empty/first.md', '# 最初\n');
    await waitFor(list, (documents) => documents.length === 1, '最初の文書が登録されない');
  });
});

describe('DOC-005 / DOC-006 閉じた文書の扱いとruleの解除', () => {
  it('閉じた文書は再走査でも再起動でも復帰せず、明示的に開くと復帰する', async () => {
    t.write('docs/a.md', '# a\n');
    t.write('docs/b.md', '# b\n');
    await t.run(['open', 'docs', '--watch', '--json']);
    await t.run(['close', 'docs/a.md', '--json']);
    expect((await rules())[0]?.suppressedPaths).toHaveLength(1);

    // 新しいfileで再走査を起こしても、閉じた文書は戻らない。
    t.write('docs/c.md', '# c\n');
    await waitFor(list, (documents) => documents.length === 2, 'cが登録されない');
    expect(titles(await list())).toEqual(['b', 'c']);

    // SYS-003（部分検証）: 再起動しても、閉じた文書の扱いとruleを復元する。
    await t.run(['daemon', 'restart', '--json']);
    t.write('docs/d.md', '# d\n');
    await waitFor(list, (documents) => documents.length === 3, 'dが登録されない');
    expect(titles(await list())).toEqual(['b', 'c', 'd']);
    expect((await rules())[0]?.suppressedPaths).toHaveLength(1);

    // 明示的に開くと、復帰させない扱いを解除する。
    await t.run(['open', 'docs/a.md', '--json']);
    expect(titles(await list())).toEqual(['a', 'b', 'c', 'd']);
    expect((await rules())[0]?.suppressedPaths).toEqual([]);
  });

  it('ruleの解除は監視だけを止め、文書は残す', async () => {
    t.write('docs/a.md', '# a\n');
    await t.run(['open', 'docs', '--watch', '--json']);
    const watchId = (await rules())[0]?.watchId as string;
    const removed = (await t.run(['watch', 'remove', watchId, '--json'])).json<{
      watchRules: WatchRule[];
    }>();
    expect(removed.data.watchRules).toEqual([]);
    expect(titles(await list())).toEqual(['a']);

    t.write('docs/b.md', '# b\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(titles(await list())).toEqual(['a']);

    const unknown = await t.run(['watch', 'remove', watchId, '--json']);
    expect(unknown.exitCode).toBe(3);
    expect(unknown.json().error.code).toBe('E_WATCH_NOT_FOUND');
  });

  it('DOC-016（部分検証）close --allは、文書と監視ruleをすべて外す', async () => {
    t.write('docs/a.md', '# a\n');
    await t.run(['open', 'docs', '--watch', '--json']);
    await t.run(['close', '--all', '--json']);
    expect(await list()).toEqual([]);
    expect(await rules()).toEqual([]);
    t.write('docs/b.md', '# b\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await list()).toEqual([]);
  });
});

describe('DOC-009 保存の途中の状態', () => {
  it('renameでの保存、削除後の作り直し、連続した追記の後、最終的な内容を反映する', async () => {
    const path = t.write('a.md', '# 最初\n');
    await t.run(['open', 'a.md', '--json']);

    // 一時fileへ書いてrenameで置き換える。
    writeFileSync(`${path}.tmp`, '# rename後\n');
    renameSync(`${path}.tmp`, path);
    await waitFor(list, (documents) => documents[0]?.title === 'rename後', 'renameが反映されない');

    // 削除してすぐ作り直す。一覧からは消えない。
    rmSync(path);
    writeFileSync(path, '# 作り直し\n');
    const recreated = await waitFor(
      list,
      (documents) => documents[0]?.title === '作り直し',
      '作り直しが反映されない',
    );
    expect(recreated).toHaveLength(1);
    expect(recreated[0]?.sourceState).toBe('ready');

    // 短い間隔で書き足す。途中の内容ではなく、最後の内容になる。
    for (let index = 1; index <= 10; index += 1) {
      writeFileSync(path, `# 追記 ${String(index)}\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await waitFor(list, (documents) => documents[0]?.title === '追記 10', '最後の内容にならない');
  });

  it('fileが消えたら状態を示し、戻ったら元に戻る', async () => {
    const path = t.write('a.md', '# a\n');
    await t.run(['open', 'a.md', '--json']);
    rmSync(path);
    const missing = await waitFor(
      list,
      (documents) => documents[0]?.sourceState === 'missing',
      'missingにならない',
    );
    expect(missing).toHaveLength(1);

    writeFileSync(path, '# 戻った\n');
    await waitFor(
      list,
      (documents) => documents[0]?.sourceState === 'ready' && documents[0]?.title === '戻った',
      'readyに戻らない',
    );
  });
});

describe('daemonが止まっている間の変更', () => {
  it('再起動した後、手動のrefreshなしで取り込む', async () => {
    const path = t.write('a.md', '# 停止前\n');
    const before = (await t.run(['open', 'a.md', '--json'])).json<{ documents: Summary[] }>().data
      .documents[0] as Summary;
    await t.run(['daemon', 'stop', '--json']);

    writeFileSync(path, '# 停止中の変更\n');

    // listはdaemonを起動するだけで、fileを読み直す指示は出さない。
    const after = await waitFor(
      list,
      (documents) => documents[0]?.title === '停止中の変更',
      '停止中の変更が反映されない',
    );
    expect(after[0]?.documentId).toBe(before.documentId);
    expect(after[0]?.revision).not.toBe(before.revision);
    const read = (await t.run(['read', before.documentId, '--json'])).json<{ content: string }>();
    expect(read.data.content).toBe('# 停止中の変更\n');
  });
});

describe('refreshとoutline', () => {
  it('refreshはfileを読み直し、outlineは見出しの構造を返す', async () => {
    t.write('a.md', '# 概要\n\n## 手順\n\n### 詳細\n');
    const opened = (await t.run(['open', 'a.md', '--json'])).json<{ documents: Summary[] }>();
    const id = opened.data.documents[0]?.documentId as string;

    const outline = (await t.run(['read', id, '--outline', '--json'])).json<{
      mode: string;
      extraction: string;
      sourceRange: unknown;
      outline: Array<{ sectionId: string; level: number; title: string; headingPath: string[] }>;
    }>();
    expect(outline.data).toMatchObject({
      mode: 'outline',
      extraction: 'markdown',
      sourceRange: null,
    });
    expect(outline.data.outline.map((item) => [item.sectionId, item.level, item.title])).toEqual([
      ['sec_0001', 1, '概要'],
      ['sec_0002', 2, '手順'],
      ['sec_0003', 3, '詳細'],
    ]);
    expect(outline.data.outline[2]?.headingPath).toEqual(['概要', '手順', '詳細']);

    const conflict = await t.run(['read', id, '--outline', '--lines', '1:2', '--json']);
    expect(conflict.exitCode).toBe(2);

    const refreshed = (await t.run(['refresh', id, '--json'])).json<{ changed: string[] }>();
    expect(refreshed.data.changed).toEqual([]);
    const focused = await t.run(['focus', id, '--json']);
    expect(focused.exitCode).toBe(0);
  });
});
