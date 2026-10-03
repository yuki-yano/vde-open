import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeDocument, type DocumentAnalysis } from '@vde-open/document';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createCursorCodec } from './cursor.ts';
import { DocumentService } from './service.ts';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'vde-open-analysis-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('DOC-010 late analysis result of an old revision', () => {
  it('is not used as the result of the new revision', async () => {
    const path = join(base, 'a.md');
    writeFileSync(path, '# Old heading\n');
    const store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });

    // Hold only the old revision's analysis until signalled.
    let releaseOld: () => void = () => undefined;
    const analyzed: string[] = [];
    const service = new DocumentService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      analyze: async (format, text): Promise<DocumentAnalysis> => {
        analyzed.push(text);
        if (text.includes('Old heading')) {
          await new Promise<void>((resolve) => {
            releaseOld = resolve;
          });
        }
        return analyzeDocument(text, format);
      },
    });

    const opened = await service.open({ cwd: base, paths: ['a.md'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    const oldRevision = opened.data.documents[0]?.revision as string;
    const oldOutline = service.read({ documentId, outline: true });

    // The document moves to a new revision before the old revision's analysis finishes.
    writeFileSync(path, '# New heading\n\n## Added section\n');
    expect((await service.refreshFromDisk(documentId)).changed).toBe(true);
    const current = await service.read({ documentId, outline: true });
    expect(current.data.revision).not.toBe(oldRevision);
    expect(current.data.outline?.map((item) => item.title)).toEqual([
      'New heading',
      'Added section',
    ]);

    // The old revision's analysis finishes late. The result is bound only to the old revision.
    releaseOld();
    const old = await oldOutline;
    expect(old.data.revision).toBe(oldRevision);
    expect(old.data.outline?.map((item) => item.title)).toEqual(['Old heading']);

    // The current revision's result is unchanged. The old result is returned only when the old revision is requested.
    const after = await service.read({ documentId, outline: true });
    expect(after.data.outline?.map((item) => item.title)).toEqual(['New heading', 'Added section']);
    const pinned = await service.read({ documentId, outline: true, revision: oldRevision });
    expect(pinned.data.outline?.map((item) => item.title)).toEqual(['Old heading']);
    // The same revision was not analyzed again.
    expect(analyzed).toHaveLength(2);
  });
});
