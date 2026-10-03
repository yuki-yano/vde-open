import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FeedbackService } from '../feedback/service.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createCursorCodec } from './cursor.ts';
import { DocumentService, type DocumentEvent } from './service.ts';

let base: string;
let store: StateStore;
let documents: DocumentService;
let events: DocumentEvent[];

const service = () => {
  events = [];
  return new DocumentService({
    store,
    cursors: createCursorCodec(randomBytes(32)),
    emit: (event) => events.push(event),
  });
};

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-html-mode-')));
  store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  documents = service();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const write = (name: string, content: string) => writeFileSync(join(base, name), content);

async function open(name: string, extra: Record<string, unknown> = {}) {
  const opened = await documents.open({ cwd: base, paths: [name], ...extra });
  return opened.data.documents[0] as {
    documentId: string;
    htmlMode: unknown;
    interactiveAllowed: boolean;
  };
}

const summaryOf = (documentId: string) =>
  documents.list({}).data.documents.find((document) => document.documentId === documentId);

describe('interactive permission (spec 10.2)', () => {
  it('is granted by an explicit option, kept across reopen and update of the same file, and revoked by a static option or close', async () => {
    write('a.html', '<p>1</p>');
    const opened = await open('a.html', { htmlMode: 'interactive' });
    expect(opened).toMatchObject({ htmlMode: 'interactive', interactiveAllowed: true });
    expect(documents.interactiveAllowed(opened.documentId)).toBe(true);

    write('a.html', '<p>2</p>');
    expect(await open('a.html')).toMatchObject({ interactiveAllowed: true });
    await documents.refresh({ documentId: opened.documentId });
    expect(documents.interactiveAllowed(opened.documentId)).toBe(true);

    expect(await open('a.html', { htmlMode: 'static' })).toMatchObject({
      htmlMode: 'static',
      interactiveAllowed: false,
    });

    await open('a.html', { htmlMode: 'interactive' });
    await documents.close({ cwd: base, targets: [opened.documentId] });
    // After a close and reopen, the requested mode remains but the permission is not carried over.
    expect(await open('a.html')).toMatchObject({
      htmlMode: 'interactive',
      interactiveAllowed: false,
    });
  });

  it('after a daemon restart only the requested mode remains, and the permission is re-granted by confirmation in the management UI', async () => {
    write('a.html', '<p>1</p>');
    const { documentId } = await open('a.html', { htmlMode: 'interactive' });
    documents = service();
    expect(summaryOf(documentId)).toMatchObject({
      htmlMode: 'interactive',
      interactiveAllowed: false,
    });

    await expect(documents.setHtmlMode({ documentId, mode: 'interactive' })).rejects.toMatchObject({
      code: 'E_CONFIRMATION_REQUIRED',
    });
    const enabled = await documents.setHtmlMode({
      documentId,
      mode: 'interactive',
      confirmed: true,
    });
    expect(enabled.data).toMatchObject({ htmlMode: 'interactive', interactiveAllowed: true });
    expect(events).toContainEqual({ type: 'document-status', documentId });
    const disabled = await documents.setHtmlMode({ documentId, mode: 'static' });
    expect(disabled.data).toMatchObject({ htmlMode: 'static', interactiveAllowed: false });
  });

  it('is not carried over by a stdin update with the same key (replacement with other content)', async () => {
    const opened = await documents.open({
      cwd: base,
      paths: [],
      stdin: { content: '<p>1</p>' },
      format: 'html',
      key: 'preview',
      htmlMode: 'interactive',
    });
    const documentId = opened.data.documents[0]?.documentId as string;
    expect(documents.interactiveAllowed(documentId)).toBe(true);
    const updated = await documents.open({
      cwd: base,
      paths: [],
      stdin: { content: '<p>2</p>' },
      format: 'html',
      key: 'preview',
    });
    expect(updated.data.documents[0]).toMatchObject({
      documentId,
      htmlMode: 'interactive',
      interactiveAllowed: false,
    });
  });

  it('new documents are static; the view mode cannot be changed for Markdown and other non-HTML documents', async () => {
    write('b.html', '<p>b</p>');
    write('c.md', '# c');
    expect(await open('b.html')).toMatchObject({ htmlMode: 'static', interactiveAllowed: false });
    const markdown = await open('c.md');
    expect(markdown.htmlMode).toBeNull();
    await expect(
      documents.setHtmlMode({
        documentId: markdown.documentId,
        mode: 'interactive',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' });
  });

  it('a question is pinned to the view mode at creation', async () => {
    const questionnaire = JSON.stringify({
      schemaVersion: 1,
      title: 'Confirm',
      fieldOrder: ['ok'],
      answerSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean', title: 'OK' } },
        required: [],
        additionalProperties: false,
      },
    });
    const feedback = new FeedbackService({ store, documents });
    write('i.html', '<p>i</p>');
    write('s.html', '<p>s</p>');
    const interactive = await open('i.html', { htmlMode: 'interactive' });
    const plain = await open('s.html');
    const asked = async (documentId: string) =>
      feedback.getForUi(
        (await feedback.create({ cwd: base, questionnaire, documentId })).data.request.requestId,
      ).data.renderMode;
    expect(await asked(interactive.documentId)).toBe('interactive');
    expect(await asked(plain.documentId)).toBe('static');
  });
});
