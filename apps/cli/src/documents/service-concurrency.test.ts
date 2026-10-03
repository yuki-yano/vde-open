import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeDocument } from '@vde-open/document';
import { LIMITS, VdeError, type DocumentFormat } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createCursorCodec } from './cursor.ts';
import { DocumentService, type DocumentEvent } from './service.ts';
import { readSourceFile, type LoadedSource } from './source-reader.ts';

let base: string;
let store: StateStore;
let events: DocumentEvent[];
let reads: string[];
let analyzedFormats: DocumentFormat[];
let service: DocumentService;
// Max number of concurrent reads of the same file.
let maxConcurrentReads: number;

interface Gate {
  // Resolves when the hold point is reached.
  reached: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
}

function createGate(): Gate {
  let reach: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    wait: () => {
      reach();
      return opened;
    },
  };
}

// Which read to hold and where. before is before reading the content, after is after.
let gates: Map<number, { before?: Gate; after?: Gate }>;
// Hook on the read result. Throwing an error makes the read fail.
let afterRead: (loaded: LoadedSource, count: number) => LoadedSource;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'vde-open-concurrency-'));
  store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  events = [];
  reads = [];
  analyzedFormats = [];
  gates = new Map();
  afterRead = (loaded) => loaded;
  maxConcurrentReads = 0;
  const active = new Map<string, number>();
  service = new DocumentService({
    store,
    cursors: createCursorCodec(randomBytes(32)),
    emit: (event) => events.push(event),
    analyze: (format, text) => {
      analyzedFormats.push(format);
      return Promise.resolve(analyzeDocument(text, format));
    },
    readSource: async (path) => {
      reads.push(path);
      const count = reads.length;
      const current = (active.get(path) ?? 0) + 1;
      active.set(path, current);
      maxConcurrentReads = Math.max(maxConcurrentReads, current);
      try {
        await gates.get(count)?.before?.wait();
        const loaded = await readSourceFile(path);
        await gates.get(count)?.after?.wait();
        return afterRead(loaded, count);
      } finally {
        active.set(path, (active.get(path) ?? 1) - 1);
      }
    },
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const write = (name: string, content: string) => {
  const path = join(base, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
};

async function currentText(documentId: string): Promise<string> {
  return (await service.read({ documentId })).data.content ?? '';
}

// Holds the next read, either before or after reading the content.
function holdNextRead(where: 'before' | 'after'): Gate {
  const gate = createGate();
  gates.set(reads.length + 1, { [where]: gate });
  return gate;
}

// Waits long enough for other work to proceed if it is not blocked.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('ordering of "read then publish" for the same file', () => {
  it('when an earlier refresh reads newer content later, a later refresh does not overwrite it with older content', async () => {
    write('a.md', '# v1\n');
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;
    write('a.md', '# v2\n');

    // Refresh A holds before reading the content.
    const holdA = holdNextRead('before');
    const a = service.refreshFromDisk(documentId);
    await holdA.reached;
    // Refresh B holds after reading, once it can read. If reads were concurrent, it would read v2 here.
    const holdB = createGate();
    gates.set(reads.length + 1, { after: holdB });
    const b = service.refreshFromDisk(documentId);
    await settle();

    // A reads and publishes after the file becomes v3.
    write('a.md', '# v3\n');
    holdA.release();
    expect((await a).changed).toBe(true);
    expect(await currentText(documentId)).toBe('# v3\n');

    // Resuming B does not go back to v2.
    holdB.release();
    await b;
    expect(await currentText(documentId)).toBe('# v3\n');
    // The same file was not read concurrently. B read after A published.
    expect(maxConcurrentReads).toBe(1);
  });

  it('a later refresh never publishes first, even if an earlier refresh is slow to publish after reading', async () => {
    write('a.md', '# v1\n');
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;

    // Refresh A holds after reading "v2".
    write('a.md', '# v2\n');
    const hold = holdNextRead('after');
    const slow = service.refreshFromDisk(documentId);
    await hold.reached;

    // The file becomes v3 and refresh B starts. B waits for A to publish.
    write('a.md', '# v3\n');
    const fast = service.refreshFromDisk(documentId);
    await settle();
    expect(await currentText(documentId)).toBe('# v1\n');

    hold.release();
    await Promise.all([slow, fast]);
    expect(await currentText(documentId)).toBe('# v3\n');
    expect(maxConcurrentReads).toBe(1);
    // The remembered file state matches the last published content (v3).
    expect(service.readSignature(documentId)).toBe((await fast).signature);
  });

  it('new content is applied last, even after a late "unreadable" result is published', async () => {
    const path = write('a.md', '# v1\n');
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;

    // Refresh A holds with an unreadable result.
    const failing = reads.length + 1;
    afterRead = (loaded, count) => {
      if (count !== failing) return loaded;
      throw new VdeError('E_INVALID_SOURCE', 'Cannot read.', { path, reason: 'invalid-utf8' });
    };
    const hold = holdNextRead('after');
    const slow = service.refreshFromDisk(documentId);
    await hold.reached;

    write('a.md', '# v2\n');
    const fast = service.refreshFromDisk(documentId);
    await settle();
    hold.release();
    await Promise.all([slow, fast]);
    expect(store.payload.documents[documentId]?.sourceState).toBe('ready');
    expect(await currentText(documentId)).toBe('# v2\n');
  });

  it('when an explicit open overlaps a refresh, the content read later is applied last', async () => {
    write('a.md', '# v1\n');
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;

    write('a.md', '# v2\n');
    const hold = holdNextRead('after');
    const opening = service.open({ cwd: base, paths: ['a.md'], title: 'Given title' });
    await hold.reached;

    write('a.md', '# v3\n');
    const refreshing = service.refreshFromDisk(documentId);
    await settle();
    hold.release();
    const opened = await opening;
    await refreshing;

    // The open succeeds and the title remains. The content is v3, read later.
    expect(opened.data.documents[0]?.title).toBe('Given title');
    expect(store.payload.documents[documentId]?.title).toBe('Given title');
    expect(await currentText(documentId)).toBe('# v3\n');
    expect(maxConcurrentReads).toBe(1);
  });

  it('refreshes of different files do not wait for each other', async () => {
    write('a.md', '# a\n');
    write('b.md', '# b\n');
    const opened = await service.open({ cwd: base, paths: ['a.md', 'b.md'] });
    const [a, b] = opened.data.documents.map((document) => document.documentId) as [string, string];

    write('a.md', '# a2\n');
    write('b.md', '# b2\n');
    const hold = holdNextRead('after');
    const slow = service.refreshFromDisk(a);
    await hold.reached;
    // b's refresh finishes even while a's refresh is held.
    expect((await service.refreshFromDisk(b)).changed).toBe(true);
    expect(await currentText(b)).toBe('# b2\n');
    hold.release();
    await slow;
    expect(await currentText(a)).toBe('# a2\n');
  });
});

describe('registration of new documents by watch rules', () => {
  it('when a scan overlaps an explicit open, the content read later is applied last', async () => {
    mkdirSync(join(base, 'docs'));
    const rule = (await service.open({ cwd: base, paths: ['docs'], watch: true })).data
      .watchRules[0];
    const watchId = rule?.watchId as string;

    // The scan holds after reading "v1".
    write('docs/b.md', '# v1\n');
    const hold = holdNextRead('after');
    const scanning = service.reconcileWatchRule(watchId);
    await hold.reached;

    // Meanwhile, the same file is opened explicitly with new content. The open waits for the scan to publish.
    write('docs/b.md', '# v2\n');
    const opening = service.open({ cwd: base, paths: ['docs/b.md'] });
    await settle();
    hold.release();
    const added = await scanning;
    const opened = await opening;
    const documentId = opened.data.documents[0]?.documentId as string;

    expect(added).toEqual([documentId]);
    expect(await currentText(documentId)).toBe('# v2\n');
    expect(maxConcurrentReads).toBe(1);
    // Both the registration by the scan and the update by the open are notified.
    expect(events.map((event) => event.type)).toEqual(['catalog-changed', 'document-changed']);
  });

  it('a document opened explicitly while the scan waits its turn is neither read nor touched', async () => {
    mkdirSync(join(base, 'docs'));
    const rule = (await service.open({ cwd: base, paths: ['docs'], watch: true })).data
      .watchRules[0];
    const watchId = rule?.watchId as string;

    // The explicit open holds after reading "v1". Not registered yet.
    write('docs/b.md', '# v1\n');
    const hold = holdNextRead('after');
    const opening = service.open({ cwd: base, paths: ['docs/b.md'] });
    await hold.reached;

    // The scan finds this file as a new candidate and waits for the open to publish.
    const scanning = service.reconcileWatchRule(watchId);
    await settle();
    hold.release();
    const opened = await opening;
    const versionAfterOpen = store.payload.catalogVersion;
    const eventsAfterOpen = events.length;

    expect(await scanning).toEqual([]);
    // The scan did not read the content. Neither state nor notifications changed.
    expect(reads.filter((path) => path.endsWith('b.md'))).toHaveLength(1);
    expect(store.payload.catalogVersion).toBe(versionAfterOpen);
    expect(events).toHaveLength(eventsAfterOpen);
    expect(await currentText(opened.data.documents[0]?.documentId as string)).toBe('# v1\n');
  });

  it('candidates beyond the count limit are rejected without reading any content', async () => {
    mkdirSync(join(base, 'many'));
    const rule = (await service.open({ cwd: base, paths: ['many'], watch: true })).data
      .watchRules[0];
    for (let index = 0; index <= LIMITS.openDocuments; index += 1) {
      writeFileSync(join(base, 'many', `${String(index)}.md`), '# x\n');
    }
    reads = [];
    await expect(service.reconcileWatchRule(rule?.watchId as string)).rejects.toMatchObject({
      code: 'E_LIMIT_EXCEEDED',
      details: { limit: 'openDocuments' },
    });
    expect(reads).toEqual([]);
    expect(store.payload.openOrder).toEqual([]);
  });

  it('once the total size limit is reached, the remaining candidates are not read', async () => {
    mkdirSync(join(base, 'big'));
    const rule = (await service.open({ cwd: base, paths: ['big'], watch: true })).data
      .watchRules[0];
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(base, 'big', `${String(index)}.md`), '# x\n');
    }
    // Treat each file as being at the size limit. The actual files stay small; only the number of reads matters.
    const large = Buffer.alloc(LIMITS.documentBytes);
    afterRead = (loaded) => ({ ...loaded, bytes: large });
    reads = [];
    await expect(service.reconcileWatchRule(rule?.watchId as string)).rejects.toMatchObject({
      code: 'E_LIMIT_EXCEEDED',
      details: { limit: 'openSourceBytes' },
    });
    // Stops when 128MiB is exceeded (the 13th file). Not all 20 are read.
    expect(reads).toHaveLength(Math.floor(LIMITS.openSourceBytes / LIMITS.documentBytes) + 1);
    expect(store.payload.openOrder).toEqual([]);
  });
});

describe('notifications for changes other than content', () => {
  it('notifies when only the title changes', async () => {
    write('a.md', '# a\n');
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;
    events = [];
    const renamed = await service.open({ cwd: base, paths: ['a.md'], title: 'New title' });
    expect(renamed.data.updated).toBe(1);
    expect(events).toEqual([
      { type: 'document-status', documentId, revision: renamed.data.documents[0]?.revision },
    ]);

    // An open that changes nothing does not notify.
    events = [];
    await service.open({ cwd: base, paths: ['a.md'], title: 'New title' });
    expect(events).toEqual([]);
  });

  it('notifies when recovering from an unreadable state with the same content', async () => {
    const path = write('a.md', '# a\n');
    const opened = await service.open({ cwd: base, paths: ['a.md'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    const revision = opened.data.documents[0]?.revision as string;

    afterRead = () => {
      throw new VdeError('E_INVALID_SOURCE', 'Cannot read.', { path, reason: 'invalid-utf8' });
    };
    events = [];
    await service.refreshFromDisk(documentId);
    expect(store.payload.documents[documentId]?.sourceState).toBe('error');
    expect(events).toEqual([{ type: 'document-status', documentId, revision }]);

    // Recovery by refresh.
    afterRead = (loaded) => loaded;
    events = [];
    expect((await service.refreshFromDisk(documentId)).changed).toBe(true);
    expect(store.payload.documents[documentId]?.sourceState).toBe('ready');
    expect(events).toEqual([{ type: 'document-status', documentId, revision }]);

    // Recovery by an explicit open.
    afterRead = () => {
      throw new VdeError('E_INVALID_SOURCE', 'Cannot read.', { path, reason: 'invalid-utf8' });
    };
    await service.refreshFromDisk(documentId);
    afterRead = (loaded) => loaded;
    events = [];
    await service.open({ cwd: base, paths: ['a.md'] });
    expect(store.payload.documents[documentId]?.sourceState).toBe('ready');
    expect(events).toEqual([{ type: 'document-status', documentId, revision }]);
  });

  it('does not notify for a reorder that keeps the same order', async () => {
    write('a.md', '# a\n');
    const opened = await service.open({ cwd: base, paths: ['a.md'] });
    events = [];
    await service.reorder({
      order: [opened.data.documents[0]?.documentId as string],
      expectedCatalogVersion: opened.catalogVersion,
    });
    expect(events).toEqual([]);
  });
});

describe('previous revision of a document reopened with another format', () => {
  it('the previous revision outline is analyzed with the format the revision was created with', async () => {
    write('a.md', '# Markdown heading\n\n<h2>HTML heading</h2>\n');
    const asMarkdown = await service.open({ cwd: base, paths: ['a.md'] });
    const documentId = asMarkdown.data.documents[0]?.documentId as string;
    const markdownRevision = asMarkdown.data.documents[0]?.revision as string;

    const asHtml = await service.open({ cwd: base, paths: ['a.md'], format: 'html' });
    const htmlRevision = asHtml.data.documents[0]?.revision as string;
    expect(htmlRevision).not.toBe(markdownRevision);

    // Read the previous revision before any analysis result exists.
    const first = await service.read({ documentId, outline: true, revision: markdownRevision });
    expect(first.data.extraction).toBe('markdown');
    expect(first.data.outline?.map((item) => item.title)).toEqual(['Markdown heading']);
    // The same after the analysis result is cached.
    const second = await service.read({ documentId, outline: true, revision: markdownRevision });
    expect(second.data.extraction).toBe('markdown');
    expect(second.data.outline?.map((item) => item.title)).toEqual(['Markdown heading']);

    const current = await service.read({ documentId, outline: true });
    expect(current.data.revision).toBe(htmlRevision);
    expect(current.data.extraction).toBe('static-html');
    expect(current.data.outline?.map((item) => item.title)).toEqual(['HTML heading']);
    expect(analyzedFormats).toEqual(['markdown', 'html']);
  });
});
