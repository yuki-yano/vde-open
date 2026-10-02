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

describe('DOC-010 遅れて届いた古い版の解析結果', () => {
  it('新しい版の結果として採用しない', async () => {
    const path = join(base, 'a.md');
    writeFileSync(path, '# 古い見出し\n');
    const store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });

    // 古い版の解析だけを、合図があるまで止める。
    let releaseOld: () => void = () => undefined;
    const analyzed: string[] = [];
    const service = new DocumentService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      analyze: async (format, text): Promise<DocumentAnalysis> => {
        analyzed.push(text);
        if (text.includes('古い見出し')) {
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

    // 古い版の解析が終わる前に、文書が新しい版になる。
    writeFileSync(path, '# 新しい見出し\n\n## 追加の節\n');
    expect((await service.refreshFromDisk(documentId)).changed).toBe(true);
    const current = await service.read({ documentId, outline: true });
    expect(current.data.revision).not.toBe(oldRevision);
    expect(current.data.outline?.map((item) => item.title)).toEqual(['新しい見出し', '追加の節']);

    // 遅れて古い版の解析が終わる。結果は古い版にだけ結び付く。
    releaseOld();
    const old = await oldOutline;
    expect(old.data.revision).toBe(oldRevision);
    expect(old.data.outline?.map((item) => item.title)).toEqual(['古い見出し']);

    // 現在の版の結果は変わらない。古い版を指定したときだけ、古い結果が返る。
    const after = await service.read({ documentId, outline: true });
    expect(after.data.outline?.map((item) => item.title)).toEqual(['新しい見出し', '追加の節']);
    const pinned = await service.read({ documentId, outline: true, revision: oldRevision });
    expect(pinned.data.outline?.map((item) => item.title)).toEqual(['古い見出し']);
    // 同じ版を解析し直してはいない。
    expect(analyzed).toHaveLength(2);
  });
});
