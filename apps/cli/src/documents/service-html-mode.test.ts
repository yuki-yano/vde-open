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

describe('interactiveの実行の許可（仕様10.2）', () => {
  it('明示的な指定で許可し、同じfileの開き直しと更新では保ち、staticの指定と閉じる操作で外す', async () => {
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
    // 閉じた後に開き直しても、希望は残るが、許可は引き継がない。
    expect(await open('a.html')).toMatchObject({
      htmlMode: 'interactive',
      interactiveAllowed: false,
    });
  });

  it('daemonを起動し直したら、希望だけが残り、許可は管理UIの確認で付け直す', async () => {
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

  it('stdinの同じkeyの更新（別の内容への置き換え）では、許可を引き継がない', async () => {
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

  it('新しい文書はstatic。MarkdownとHTMLでない文書では、表示方法を変えられない', async () => {
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

  it('質問は、作ったときの表示方法に固定する', async () => {
    const questionnaire = JSON.stringify({
      schemaVersion: 1,
      title: '確認',
      fieldOrder: ['ok'],
      answerSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean', title: 'よい' } },
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
