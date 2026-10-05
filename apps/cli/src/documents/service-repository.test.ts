import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import type { DocumentSummary } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs, type StoreFs } from '../persistence/store-fs.ts';
import { createCursorCodec } from './cursor.ts';
import { gitDir, worktree, writeFile } from './git.fixture.ts';
import type { Detection, RepositoryDetector, RepositoryFs } from './repository.ts';
import { nodeRepositoryFs } from './repository.ts';
import type { RepositoryTrackerOptions } from './repository-tracker.ts';
import { DocumentService, type DocumentEvent } from './service.ts';

let base: string;
let store: StateStore;
let events: DocumentEvent[];
let failCommits: boolean;

const cursors = createCursorCodec(randomBytes(32));

// A store whose commits can be made to fail before anything is written.
const storeFs: StoreFs = {
  ...nodeStoreFs,
  writeFileDurable: (path, data, mode) =>
    failCommits
      ? Promise.reject(new Error('disk full'))
      : nodeStoreFs.writeFileDurable(path, data, mode),
};

const serviceWith = (repositories: RepositoryTrackerOptions = {}) =>
  new DocumentService({
    store,
    cursors,
    emit: (event) => events.push(event),
    // Late results are applied at once, so the tests do not wait for the gathering delay.
    repositories: { stopAt: base, lateApplyMs: 0, lateApplyMaxMs: 0, ...repositories },
  });

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-service-repo-')));
  store = await StateStore.open({ root: join(base, 'home'), fs: storeFs });
  events = [];
  failCommits = false;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const segments = (path: string) => path.split(sep).filter((part) => part !== '');

const open = async (service: DocumentService, ...paths: string[]) =>
  (await service.open({ cwd: base, paths })).data.documents;

const listed = (service: DocumentService) => service.list({ limit: 500 }).data.documents;

const byId = (service: DocumentService, documentId: string) =>
  listed(service).find((document) => document.documentId === documentId) as DocumentSummary;

// Detection the test finishes by hand, with any result, in any order.
const manualDetection = () => {
  const calls: Array<{ path: string; finish: (detection: Detection) => void }> = [];
  const createDetector = (): RepositoryDetector => ({
    detect: (path) =>
      new Promise<Detection>((finish) => {
        calls.push({ path, finish });
      }),
  });
  return { calls, createDetector };
};

const resolvedIn = (id: string, branch: string | null = null): Detection => ({
  state: 'resolved',
  id,
  nameSegments: segments(id),
  checkout: { id, kind: 'main' },
  pathInCheckout: branch === null ? ['a.md'] : [branch, 'a.md'],
});

// Lets finished detection reach its transaction, then waits for every queued transaction (and what follows its commit).
const settle = async () => {
  // Longer than the gathering timer (0 ms here), which is set only after the detection settles.
  await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  await store.transaction(() => undefined);
};

describe('repositories in document summaries', () => {
  it('shows the repository and the canonical path of a file document', async () => {
    const repo = join(base, 'vde-open');
    gitDir(join(repo, '.git'));
    const service = serviceWith();
    const [document] = await open(service, writeFile(join(repo, 'docs', 'design.md'), '# Design'));

    expect(document).toMatchObject({
      canonicalPath: join(repo, 'docs', 'design.md'),
      repository: {
        state: 'resolved',
        id: join(repo, '.git'),
        nameSegments: segments(repo),
        checkout: { id: repo, kind: 'main' },
        pathInCheckout: ['docs', 'design.md'],
      },
    });
  });

  it('has no repository for a file outside a repository and for stdin', async () => {
    const service = serviceWith();
    const [file] = await open(service, writeFile(join(base, 'notes', 'a.md'), 'a'));
    const stdin = (
      await service.open({ cwd: base, paths: [], stdin: { content: '# s' }, format: 'markdown' })
    ).data.documents[0];

    expect(file).toMatchObject({ repository: null });
    expect(stdin).toMatchObject({ canonicalPath: null, repository: null });
  });

  it('shares the branch within a checkout, and updates it on the next open', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const checkout = join(repo, '.git', 'wt', 'feature', 'x');
    const admin = worktree(join(repo, '.git'), checkout, 'x', {
      head: 'ref: refs/heads/feature/x\n',
    });
    const service = serviceWith();
    const [a, b] = await open(
      service,
      writeFile(join(checkout, 'a.md'), 'a'),
      writeFile(join(checkout, 'docs', 'b.md'), 'b'),
    );
    expect(a?.repository).toMatchObject({ checkout: { kind: 'linked', branch: 'feature/x' } });
    expect(b?.repository).toMatchObject({ checkout: { kind: 'linked', branch: 'feature/x' } });

    // The worktree switched branches. Opening one document again updates every document of the checkout.
    writeFile(join(admin, 'HEAD'), 'ref: refs/heads/feature/y\n');
    const versionBefore = store.payload.catalogVersion;
    const revisionBefore = byId(service, b?.documentId as string).revision;
    events = [];
    await open(service, join(checkout, 'a.md'));

    for (const document of listed(service)) {
      expect(document.repository).toMatchObject({
        checkout: { kind: 'linked', name: 'x', branch: 'feature/y' },
      });
    }
    expect(store.payload.catalogVersion).toBe(versionBefore + 1);
    expect(events.filter((event) => event.type === 'catalog-changed')).toHaveLength(1);
    expect(byId(service, b?.documentId as string).revision).toBe(revisionBefore);
  });

  it('makes a paged list start again when a repository changes in between', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const checkout = join(base, 'wt');
    const admin = worktree(join(repo, '.git'), checkout, 'wt');
    const service = serviceWith();
    await open(
      service,
      writeFile(join(checkout, 'a.md'), 'a'),
      writeFile(join(checkout, 'b.md'), 'b'),
    );
    const first = service.list({ limit: 1 }).data;

    writeFile(join(admin, 'HEAD'), 'ref: refs/heads/other\n');
    await service.refresh({});

    expect(() => service.list({ limit: 1, cursor: first.nextCursor })).toThrow(
      expect.objectContaining({ code: 'E_CURSOR_STALE' }),
    );
  });

  it('does not change the catalog version when nothing about repositories changes', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const service = serviceWith();
    await open(service, writeFile(join(repo, 'a.md'), 'a'));
    const version = store.payload.catalogVersion;
    events = [];

    await open(service, join(repo, 'a.md'));
    await service.refresh({});

    expect(store.payload.catalogVersion).toBe(version);
    expect(events).toEqual([]);
  });

  it('keeps the earlier value when saving fails', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const checkout = join(base, 'wt');
    const admin = worktree(join(repo, '.git'), checkout, 'wt');
    const service = serviceWith();
    const [document] = await open(service, writeFile(join(checkout, 'a.md'), 'a'));

    writeFile(join(admin, 'HEAD'), 'ref: refs/heads/other\n');
    writeFile(join(checkout, 'a.md'), 'changed');
    failCommits = true;
    await expect(open(service, join(checkout, 'a.md'))).rejects.toThrow('could not be saved');
    failCommits = false;

    expect(byId(service, document?.documentId as string).repository).toMatchObject({
      checkout: { branch: 'wt' },
    });
  });

  it('forgets a closed document and detects it again when it is opened again', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const service = serviceWith();
    const path = writeFile(join(repo, 'a.md'), 'a');
    const [document] = await open(service, path);
    expect(service.retainedCounts()).toMatchObject({
      repositoryDocuments: 1,
      repositoryCheckouts: 1,
    });

    await service.close({ cwd: base, targets: [document?.documentId as string] });
    expect(service.retainedCounts()).toMatchObject({
      repositoryDocuments: 0,
      repositoryCheckouts: 0,
    });

    const [again] = await open(service, path);
    expect(again?.repository).toMatchObject({ state: 'resolved', id: join(repo, '.git') });
  });

  it('detects the documents of a watch rule', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    mkdirSync(join(repo, 'docs'), { recursive: true });
    const service = serviceWith();
    const { watchRules } = (
      await service.open({ cwd: base, paths: [join(repo, 'docs')], watch: true })
    ).data;
    writeFile(join(repo, 'docs', 'new.md'), 'n');

    await service.reconcileWatchRule(watchRules[0]?.watchId as string);

    expect(listed(service)[0]).toMatchObject({
      repository: { state: 'resolved', pathInCheckout: ['docs', 'new.md'] },
    });
  });
});

describe('detection that finishes late', () => {
  it('shows pending until detection finishes, then notifies once', async () => {
    const manual = manualDetection();
    const service = serviceWith({ createDetector: manual.createDetector, waitMs: 10 });
    const path = writeFile(join(base, 'a.md'), 'a');
    const [document] = await open(service, path);
    expect(document?.repository).toEqual({ state: 'pending' });
    const version = store.payload.catalogVersion;
    events = [];

    manual.calls[0]?.finish(resolvedIn(join(base, 'repo')));
    await settle();

    expect(byId(service, document?.documentId as string).repository).toMatchObject({
      state: 'resolved',
      id: join(base, 'repo'),
    });
    expect(store.payload.catalogVersion).toBe(version + 1);
    expect(events).toEqual([{ type: 'catalog-changed' }]);
  });

  it.each([
    { change: 'moved to another checkout', newer: (): Detection => resolvedIn(join(base, 'b')) },
    { change: 'left the repository', newer: (): Detection => ({ state: 'outside' }) },
  ])('never rolls back after the document $change', async ({ newer }) => {
    const manual = manualDetection();
    const service = serviceWith({ createDetector: manual.createDetector, waitMs: 10 });
    const [document] = await open(service, writeFile(join(base, 'a.md'), 'a'));

    // A refresh detects again and finishes first.
    const refreshing = service.refresh({});
    await settle();
    await refreshing;
    const detection = newer();
    manual.calls[1]?.finish(detection);
    await settle();
    const shown = byId(service, document?.documentId as string).repository;
    expect(shown).toEqual(detection.state === 'outside' ? null : detection);
    const version = store.payload.catalogVersion;

    // The first detection finishes last, with what it saw before.
    manual.calls[0]?.finish(resolvedIn(join(base, 'a')));
    await settle();

    expect(byId(service, document?.documentId as string).repository).toEqual(shown);
    expect(store.payload.catalogVersion).toBe(version);
  });

  it('applies each late result without waiting for the rest of its batch', async () => {
    const manual = manualDetection();
    const service = serviceWith({ createDetector: manual.createDetector, waitMs: 10 });
    const [a, b] = await open(
      service,
      writeFile(join(base, 'a.md'), 'a'),
      writeFile(join(base, 'b.md'), 'b'),
    );
    expect(manual.calls).toHaveLength(2);
    events = [];

    // Only the first finishes; the second stays stuck.
    manual.calls
      .find((call) => call.path === join(base, 'a.md'))
      ?.finish(resolvedIn(join(base, 'r')));
    await settle();

    expect(byId(service, a?.documentId as string).repository).toMatchObject({ state: 'resolved' });
    expect(byId(service, b?.documentId as string).repository).toEqual({ state: 'pending' });
    expect(events).toEqual([{ type: 'catalog-changed' }]);
  });

  it('moves every document of a checkout to the new repository together', async () => {
    const manual = manualDetection();
    const service = serviceWith({ createDetector: manual.createDetector, waitMs: 10 });
    const checkout = join(base, 'wt');
    const linked = (repository: string, path: string): Detection => ({
      state: 'resolved',
      id: join(base, repository, '.git'),
      nameSegments: segments(join(base, repository)),
      checkout: { id: checkout, kind: 'linked', name: 'wt', branch: repository },
      pathInCheckout: [path],
    });
    const [a, b] = await open(
      service,
      writeFile(join(checkout, 'a.md'), 'a'),
      writeFile(join(checkout, 'b.md'), 'b'),
    );
    for (const call of manual.calls)
      call.finish(linked('repo-a', call.path.split(sep).at(-1) ?? ''));
    await settle();

    // The worktree was made again from another repository. Only a.md is opened again.
    const reopening = open(service, join(checkout, 'a.md'));
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    manual.calls.at(-1)?.finish(linked('repo-b', 'a.md'));
    await reopening;
    await settle();

    for (const document of [a, b]) {
      expect(byId(service, document?.documentId as string).repository).toMatchObject({
        id: join(base, 'repo-b', '.git'),
        nameSegments: segments(join(base, 'repo-b')),
        checkout: { id: checkout, branch: 'repo-b' },
      });
    }
  });

  it('does not attach a result started before a close to the reopened document', async () => {
    const manual = manualDetection();
    const service = serviceWith({ createDetector: manual.createDetector, waitMs: 10 });
    const path = writeFile(join(base, 'a.md'), 'a');
    const [document] = await open(service, path);
    await service.close({ cwd: base, targets: [document?.documentId as string] });
    await open(service, path);
    manual.calls[1]?.finish(resolvedIn(join(base, 'reopened')));
    await settle();

    manual.calls[0]?.finish(resolvedIn(join(base, 'stale')));
    await settle();

    expect(byId(service, document?.documentId as string).repository).toMatchObject({
      id: join(base, 'reopened'),
    });
  });

  it('does not bring back a closed document', async () => {
    const manual = manualDetection();
    const service = serviceWith({ createDetector: manual.createDetector, waitMs: 10 });
    const [document] = await open(service, writeFile(join(base, 'a.md'), 'a'));
    await service.close({ cwd: base, targets: [document?.documentId as string] });
    const version = store.payload.catalogVersion;

    manual.calls[0]?.finish(resolvedIn(join(base, 'late')));
    await settle();

    expect(service.retainedCounts()).toMatchObject({
      repositoryDocuments: 0,
      repositoryCheckouts: 0,
    });
    expect(store.payload.catalogVersion).toBe(version);
  });

  it('keeps the earlier value of an open document while detecting again', async () => {
    const manual = manualDetection();
    const service = serviceWith({ createDetector: manual.createDetector, waitMs: 10 });
    const path = writeFile(join(base, 'a.md'), 'a');
    const [document] = await open(service, path);
    manual.calls[0]?.finish(resolvedIn(join(base, 'repo')));
    await settle();

    await open(service, path);
    await service.refresh({});

    expect(byId(service, document?.documentId as string).repository).toMatchObject({
      id: join(base, 'repo'),
    });
  });

  it('answers open and refresh within the wait limit while two operations are stuck', async () => {
    // lstat hangs for anything under "stuck". Each stuck operation keeps one of the two slots.
    const stuck: Array<() => void> = [];
    const fs: RepositoryFs = {
      ...nodeRepositoryFs,
      lstat: (path) =>
        path.includes(`${sep}stuck`)
          ? new Promise((resolveStuck) => {
              stuck.push(() => resolveStuck(nodeRepositoryFs.lstat(path)));
            })
          : nodeRepositoryFs.lstat(path),
    };
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const service = serviceWith({ fs });
    await open(
      service,
      writeFile(join(base, 'stuck1', 'a.md'), 'a'),
      writeFile(join(base, 'stuck2', 'b.md'), 'b'),
    );
    expect(stuck).toHaveLength(2);

    let started = Date.now();
    const [local] = await open(service, writeFile(join(repo, 'c.md'), 'c'));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(local?.repository).toEqual({ state: 'pending' });
    started = Date.now();
    await service.refresh({ documentId: local?.documentId });
    expect(Date.now() - started).toBeLessThan(3000);

    for (const release of stuck) release();
    await vi.waitFor(() =>
      expect(byId(service, local?.documentId as string).repository).toMatchObject({
        state: 'resolved',
        id: join(repo, '.git'),
      }),
    );
  });
});

describe('at daemon start', () => {
  it('detects open documents, including missing ones, without changing the catalog version', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const first = serviceWith();
    await open(
      first,
      writeFile(join(repo, 'a.md'), 'a'),
      writeFile(join(repo, 'gone', 'b.md'), 'b'),
    );
    unlinkSync(join(repo, 'gone', 'b.md'));
    rmSync(join(repo, 'gone'), { recursive: true });
    const version = store.payload.catalogVersion;
    events = [];

    const restarted = serviceWith();
    expect(listed(restarted).map((document) => document.repository)).toEqual([
      { state: 'pending' },
      { state: 'pending' },
    ]);
    await restarted.initializeRepositories();

    expect(listed(restarted).map((document) => document.repository)).toMatchObject([
      { state: 'resolved', pathInCheckout: ['a.md'] },
      { state: 'resolved', pathInCheckout: ['gone', 'b.md'] },
    ]);
    expect(store.payload.catalogVersion).toBe(version);
    expect(events).toEqual([]);
  });

  it('starts with pending when detection does not finish in time, then applies it', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    await open(serviceWith(), writeFile(join(repo, 'a.md'), 'a'));
    const manual = manualDetection();
    const restarted = serviceWith({ createDetector: manual.createDetector, waitMs: 10 });
    events = [];

    await restarted.initializeRepositories();
    expect(listed(restarted)[0]?.repository).toEqual({ state: 'pending' });

    manual.calls[0]?.finish(resolvedIn(repo));
    await settle();
    expect(listed(restarted)[0]?.repository).toMatchObject({ state: 'resolved', id: repo });
    expect(events).toEqual([{ type: 'catalog-changed' }]);
  });
});
