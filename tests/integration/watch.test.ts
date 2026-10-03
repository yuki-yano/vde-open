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

// Wait for the watch to reflect changes. Re-fetch the list until the condition holds.
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

describe('DOC-004 following updates, and registering new documents with --watch', () => {
  it('a normal open also follows updates to that file', async () => {
    const path = t.write('a.md', '# 版1\n');
    const before = (await t.run(['open', 'a.md', '--json'])).json<{ documents: Summary[] }>().data
      .documents[0] as Summary;
    writeFileSync(path, '# 版2\n');
    const after = await waitFor(
      list,
      (documents) => documents[0]?.title === '版2',
      'update not reflected',
    );
    expect(after[0]?.documentId).toBe(before.documentId);
    expect(after[0]?.revision).not.toBe(before.revision);
    // Without --watch, new files in the same directory are not registered.
    t.write('b.md', '# 追加\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(titles(await list())).toEqual(['版2']);
  });

  it('registers only documents that appear in a directory opened with --watch', async () => {
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
    await waitFor(list, (documents) => documents.length === 3, 'new documents not registered');
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Only target extensions. Hidden files and files under non-recursed directories are skipped.
    expect(titles(await list())).toEqual(['a', 'b', 'c']);
  });

  it('--watch with a glob registers new documents matching the pattern', async () => {
    t.write('notes/x.md', '# x\n');
    await t.run(['open', 'notes/**/*.md', '--watch', '--json']);
    t.write('notes/deep/y.md', '# y\n');
    t.write('notes/deep/z.html', '<title>z</title>');
    await waitFor(list, (documents) => documents.length === 2, 'glob matches not registered');
    expect(titles(await list())).toEqual(['x', 'y']);
  });

  it('a rule can be registered with --watch even for a directory with no matches yet', async () => {
    mkdirSync(join(t.work, 'empty'));
    const opened = await t.run(['open', 'empty', '--watch', '--json']);
    expect(opened.exitCode).toBe(0);
    t.write('empty/first.md', '# 最初\n');
    await waitFor(list, (documents) => documents.length === 1, 'first document not registered');
  });
});

describe('DOC-005 / DOC-006 handling closed documents and removing rules', () => {
  it('a closed document does not come back on rescan or restart, and comes back when opened explicitly', async () => {
    t.write('docs/a.md', '# a\n');
    t.write('docs/b.md', '# b\n');
    await t.run(['open', 'docs', '--watch', '--json']);
    await t.run(['close', 'docs/a.md', '--json']);
    expect((await rules())[0]?.suppressedPaths).toHaveLength(1);

    // Even when a new file triggers a rescan, the closed document does not return.
    t.write('docs/c.md', '# c\n');
    await waitFor(list, (documents) => documents.length === 2, 'c not registered');
    expect(titles(await list())).toEqual(['b', 'c']);

    // SYS-003 (partial): the handling of closed documents and the rules are restored after a restart.
    await t.run(['daemon', 'restart', '--json']);
    t.write('docs/d.md', '# d\n');
    await waitFor(list, (documents) => documents.length === 3, 'd not registered');
    expect(titles(await list())).toEqual(['b', 'c', 'd']);
    expect((await rules())[0]?.suppressedPaths).toHaveLength(1);

    // Opening explicitly lifts the suppression.
    await t.run(['open', 'docs/a.md', '--json']);
    expect(titles(await list())).toEqual(['a', 'b', 'c', 'd']);
    expect((await rules())[0]?.suppressedPaths).toEqual([]);
  });

  it('removing a rule stops only the watch and keeps the documents', async () => {
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

  it('DOC-016 (partial) close --all removes all documents and watch rules', async () => {
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

describe('DOC-009 intermediate states while saving', () => {
  it('reflects the final content after a save by rename, a recreate after delete, and consecutive appends', async () => {
    const path = t.write('a.md', '# 最初\n');
    await t.run(['open', 'a.md', '--json']);

    // Write to a temporary file and replace by rename.
    writeFileSync(`${path}.tmp`, '# rename後\n');
    renameSync(`${path}.tmp`, path);
    await waitFor(list, (documents) => documents[0]?.title === 'rename後', 'rename not reflected');

    // Delete and recreate immediately. It does not disappear from the list.
    rmSync(path);
    writeFileSync(path, '# 作り直し\n');
    const recreated = await waitFor(
      list,
      (documents) => documents[0]?.title === '作り直し',
      'recreate not reflected',
    );
    expect(recreated).toHaveLength(1);
    expect(recreated[0]?.sourceState).toBe('ready');

    // Append at short intervals. The result is the last content, not an intermediate one.
    for (let index = 1; index <= 10; index += 1) {
      writeFileSync(path, `# 追記 ${String(index)}\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await waitFor(
      list,
      (documents) => documents[0]?.title === '追記 10',
      'did not become the last content',
    );
  });

  it('shows the state when the file disappears, and recovers when it returns', async () => {
    const path = t.write('a.md', '# a\n');
    await t.run(['open', 'a.md', '--json']);
    rmSync(path);
    const missing = await waitFor(
      list,
      (documents) => documents[0]?.sourceState === 'missing',
      'did not become missing',
    );
    expect(missing).toHaveLength(1);

    writeFileSync(path, '# 戻った\n');
    await waitFor(
      list,
      (documents) => documents[0]?.sourceState === 'ready' && documents[0]?.title === '戻った',
      'did not return to ready',
    );
  });
});

describe('changes while the daemon is stopped', () => {
  it('picks them up after a restart without a manual refresh', async () => {
    const path = t.write('a.md', '# 停止前\n');
    const before = (await t.run(['open', 'a.md', '--json'])).json<{ documents: Summary[] }>().data
      .documents[0] as Summary;
    await t.run(['daemon', 'stop', '--json']);

    writeFileSync(path, '# 停止中の変更\n');

    // list only starts the daemon and does not ask to re-read files.
    const after = await waitFor(
      list,
      (documents) => documents[0]?.title === '停止中の変更',
      'change while stopped not reflected',
    );
    expect(after[0]?.documentId).toBe(before.documentId);
    expect(after[0]?.revision).not.toBe(before.revision);
    const read = (await t.run(['read', before.documentId, '--json'])).json<{ content: string }>();
    expect(read.data.content).toBe('# 停止中の変更\n');
  });
});

describe('refresh and outline', () => {
  it('refresh re-reads the file, and outline returns the heading structure', async () => {
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
