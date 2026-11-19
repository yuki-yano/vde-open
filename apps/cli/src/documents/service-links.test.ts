import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VdeError } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createCursorCodec } from './cursor.ts';
import { DocumentService } from './service.ts';

let base: string;
let documents: DocumentService;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-links-')));
  documents = new DocumentService({
    store: await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs }),
    cursors: createCursorCodec(randomBytes(32)),
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const write = (name: string, content: string) => {
  const path = join(base, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

const titles = () => documents.list({}).data.documents.map((document) => document.title);

describe('SEC-019 opening documents from links in a document', () => {
  it('opens an unregistered document only with a confirmation issued for that link, used once', async () => {
    write(
      'site/index.html',
      '<a href="next.md">n</a><a href="other.md">o</a><a href="gone.md">g</a>',
    );
    write('site/next.md', '# next\n');
    write('site/other.md', '# other\n');
    const index = (await documents.open({ cwd: base, paths: ['site/index.html'] })).data
      .documents[0];
    // The render service maps a link ID to the href it extracted. Here the pair is given directly.
    const follow = (linkId: string, href: string, confirmation?: string) =>
      documents.openLinked({
        documentId: index?.documentId as string,
        revision: index?.revision as string,
        linkId,
        href,
        confirmation,
      });
    // Expects a request for confirmation, and returns its details.
    const asked = async (linkId: string, href: string, confirmation?: string) => {
      const error = await follow(linkId, href, confirmation).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        code: 'E_CONFIRMATION_REQUIRED',
        details: { changed: confirmation !== undefined },
      });
      return (error as VdeError).details as { path: string; confirmation: string };
    };

    const first = await asked('lnk_0001', 'next.md');
    expect(first.path).toBe(join(base, 'site', 'next.md'));
    // A made-up value, or a confirmation issued for another link, does not open it.
    await asked('lnk_0001', 'next.md', 'true');
    await asked('lnk_0001', 'next.md', (await asked('lnk_0002', 'other.md')).confirmation);
    expect(titles()).toEqual(['index.html']);

    const opened = await follow('lnk_0001', 'next.md', first.confirmation);
    expect(opened.data.status).toBe('opened');
    expect(titles()).toEqual(['index.html', 'next']);
    // An open document is only focused, without confirmation.
    expect((await follow('lnk_0001', 'next.md')).data).toEqual({
      status: 'focused',
      documentId: opened.data.documentId,
    });

    // After a close, the used confirmation no longer opens it.
    await documents.close({ cwd: base, targets: [opened.data.documentId] });
    const pending = (await asked('lnk_0001', 'next.md', first.confirmation)).confirmation;
    // Focusing alone consumes a confirmation too.
    await documents.open({ cwd: base, paths: ['site/next.md'] });
    expect((await follow('lnk_0001', 'next.md', pending)).data.status).toBe('focused');
    await documents.close({ cwd: base, targets: ['site/next.md'] });
    await asked('lnk_0001', 'next.md', pending);
    expect(titles()).toEqual(['index.html']);

    // Whether a target exists is revealed only after confirmation.
    const gone = await asked('lnk_0003', 'gone.md');
    await expect(follow('lnk_0003', 'gone.md', gone.confirmation)).rejects.toMatchObject({
      code: 'E_PATH_NOT_FOUND',
    });
    expect(titles()).toEqual(['index.html']);
  });
});
