// @vitest-environment happy-dom
import type {
  DocumentSummary,
  FeedbackForUi,
  Questionnaire,
  RenderGrantResult,
  ServerEvent,
} from '@vde-open/shared';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '@/App';
import type { Api } from '@/lib/api';

import { Viewer } from './viewer.tsx';

const REV1 = `rev_${'1'.repeat(64)}`;
const REV2 = `rev_${'2'.repeat(64)}`;
const T0 = '2026-10-03T00:00:00.000Z';
const REQUEST_ID = `req_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;

const questionnaire: Questionnaire = {
  schemaVersion: 1,
  title: '本文の確認',
  fieldOrder: ['verdict'],
  answerSchema: {
    type: 'object',
    properties: { verdict: { type: 'string', title: '判定', enum: ['OK', 'NG'] } },
    required: ['verdict'],
    additionalProperties: false,
  },
};

function documentOf(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    documentId: 'doc_1',
    key: null,
    format: 'html',
    sourceKind: 'file',
    title: '文書',
    displayPath: 'a.html',
    pathSegments: ['a.html'],
    revision: REV1,
    sourceState: 'ready',
    searchState: 'ready',
    openedAt: T0,
    updatedAt: T0,
    order: 0,
    pendingRequestIds: [],
    htmlMode: 'static',
    interactiveAllowed: false,
    ...overrides,
  };
}

function requestOf(overrides: Partial<FeedbackForUi> = {}): FeedbackForUi {
  return {
    requestId: REQUEST_ID,
    documentId: 'doc_1',
    revision: REV1,
    title: questionnaire.title,
    status: 'pending',
    createdAt: T0,
    submission: null,
    cancellation: null,
    acknowledgedAt: null,
    questionnaire,
    renderMode: 'static',
    draftVersion: 0,
    draftAnswers: {},
    currentRevision: REV1,
    documentOpen: true,
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;
// 本文を取得した版。
let contentRequests: string[];
// daemonの現在の状態（偽のAPIが返す）。
let current: { documents: DocumentSummary[]; request: FeedbackForUi };
let feedbackRequests: number;
let handlers: { onEvent: (event: ServerEvent) => void; onConnect: () => void } | null;
let api: Api;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  // 原文の表示にして、取得した本文をそのまま画面に出す。
  window.localStorage.setItem('vde-open.pref.view-mode', JSON.stringify('source'));
  contentRequests = [];
  feedbackRequests = 0;
  handlers = null;
  current = { documents: [documentOf()], request: requestOf() };
  api = {
    content: (_documentId: string, revision: string) => {
      contentRequests.push(revision);
      return Promise.resolve(`本文 ${revision.slice(4, 5)}`);
    },
    outline: () => Promise.resolve([]),
    renderGrant: () => new Promise<RenderGrantResult>(() => undefined),
    feedbackRenderGrant: () => new Promise<RenderGrantResult>(() => undefined),
    releaseGrants: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    documents: () =>
      Promise.resolve({ documents: current.documents, catalogVersion: 1, cursor: null }),
    status: () => Promise.resolve({ activeDocumentId: 'doc_1' }),
    feedback: () => {
      feedbackRequests += 1;
      return Promise.resolve(current.request);
    },
    events: (next: NonNullable<typeof handlers>) => {
      handlers = next;
      return { close: () => undefined };
    },
  } as unknown as Api;
});

afterEach(() => {
  root.unmount();
  container.remove();
  window.localStorage.clear();
});

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
// 条件が成り立つまで待つ。testを並行して動かす負荷の下では、画面の更新に時間がかかる。
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await settle(10);
}
const shownText = () => container.querySelector('pre')?.textContent ?? '';
function button(text: string): HTMLButtonElement {
  // iconだけのbuttonは、aria-labelで探す。
  const found = [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.includes(text) || item.getAttribute('aria-label') === text,
  );
  if (!found) throw new Error(`${text} のbuttonが見つかりません`);
  return found;
}
const statusText = () =>
  container.querySelector('[data-testid="feedback-status"]')?.textContent ?? '';

describe('FB-015 回答待ちの版の表示', () => {
  it('質問の版は、更新を止める操作より優先し、その間は更新の停止を操作できない', async () => {
    const document = documentOf({ revision: REV2 });
    root.render(<Viewer api={api} document={document} fixedRevision={REV1} />);
    await until(() => shownText() !== '');
    expect(shownText()).toBe('本文 1');
    const pause = button('更新を止める');
    expect(pause.disabled).toBe(true);
    pause.click();
    await settle();
    expect(shownText()).toBe('本文 1');
    expect(contentRequests).toEqual([REV1]);
    expect(container.textContent).toContain('質問の版を表示中');
  });

  it('質問の前から更新を止めていても、質問の版を表示する', async () => {
    root.render(<Viewer api={api} document={documentOf()} fixedRevision={null} />);
    await until(() => shownText() !== '');
    button('更新を止める').click();
    await settle();
    // 止めている間に新しい版ができ、その版へ質問が来た。
    root.render(
      <Viewer api={api} document={documentOf({ revision: REV2 })} fixedRevision={null} />,
    );
    await settle();
    expect(shownText()).toBe('本文 1');
    root.render(
      <Viewer api={api} document={documentOf({ revision: REV2 })} fixedRevision={REV2} />,
    );
    await until(() => shownText() === '本文 2');
    expect(shownText()).toBe('本文 2');
  });
});

describe('SYS-013 通知の再接続と質問の再取得', () => {
  async function showPendingQuestion(): Promise<void> {
    current.documents = [documentOf({ pendingRequestIds: [REQUEST_ID] })];
    root.render(<Workspace api={api} />);
    await settle();
    handlers?.onConnect();
    handlers?.onEvent({ type: 'hello', daemonId: 'd1', sequence: 1, catalogVersion: 1 });
    await until(() => statusText() !== '');
    expect(statusText()).toBe('未回答');
  }

  // 切れていた間に、質問が中止された。
  function cancelWhileDisconnected(): number {
    current.documents = [documentOf()];
    current.request = requestOf({
      status: 'cancelled',
      cancellation: { reason: 'user_cancelled', cancelledAt: T0 },
    } as Partial<FeedbackForUi>);
    return feedbackRequests;
  }

  it('接続し直したら、表示中の質問を取り直す', async () => {
    await showPendingQuestion();
    const before = cancelWhileDisconnected();
    handlers?.onConnect();
    handlers?.onEvent({ type: 'hello', daemonId: 'd1', sequence: 1, catalogVersion: 1 });
    await until(() => statusText() === '中止されました');
    expect(feedbackRequests).toBeGreaterThan(before);
    expect(statusText()).toBe('中止されました');
  });

  it('通知の連番が欠けたときと、resync-requiredのときも取り直す', async () => {
    await showPendingQuestion();
    let before = cancelWhileDisconnected();
    handlers?.onEvent({ type: 'document-status', daemonId: 'd1', sequence: 5, catalogVersion: 1 });
    await until(() => statusText() === '中止されました');
    expect(feedbackRequests).toBeGreaterThan(before);
    expect(statusText()).toBe('中止されました');

    before = feedbackRequests;
    handlers?.onEvent({ type: 'resync-required', daemonId: 'd1', sequence: 6, catalogVersion: 1 });
    await until(() => feedbackRequests > before);
    expect(feedbackRequests).toBeGreaterThan(before);
  });
});

describe('UX-002 検索の結果の版と、表示中の版', () => {
  const notice = () =>
    container.querySelector('[data-testid="section-target-notice"]')?.textContent ?? '';
  const target = (revision: string, nonce = 1) => ({ sectionId: 'sec_0001', revision, nonce });

  it('質問の版を表示している間は、新しい版の結果へ移動せず、理由を示して質問の版を保つ', async () => {
    root.render(
      <Viewer
        api={api}
        document={documentOf({ revision: REV2 })}
        fixedRevision={REV1}
        sectionTarget={target(REV2)}
      />,
    );
    await until(() => notice() !== '');
    expect(notice()).toContain('回答待ちの質問の版を表示しているため、移動しません');
    expect(shownText()).toBe('本文 1');
    expect(contentRequests).toEqual([REV1]);
  });

  it('更新を止めている間と、検索の後に更新された場合も、別の版の結果へは移動しない', async () => {
    root.render(<Viewer api={api} document={documentOf()} sectionTarget={null} />);
    await until(() => shownText() !== '');
    button('更新を止める').click();
    await settle();
    root.render(
      <Viewer api={api} document={documentOf({ revision: REV2 })} sectionTarget={target(REV2)} />,
    );
    await until(() => notice() !== '');
    expect(notice()).toContain('更新を止めているため、移動しません');
    expect(shownText()).toBe('本文 1');

    root.unmount();
    root = createRoot(container);
    root.render(
      <Viewer api={api} document={documentOf({ revision: REV2 })} sectionTarget={target(REV1)} />,
    );
    await until(() => notice() !== '');
    expect(notice()).toContain('検索した後に文書が更新されたため');
  });

  it('版が同じでも移動しない表示では、その旨を示し、閉じると次の移動まで出さない', async () => {
    root.render(<Viewer api={api} document={documentOf()} sectionTarget={target(REV1)} />);
    await until(() => notice() !== '');
    expect(notice()).toContain('この表示では、節の位置へ移動しません');
    button('閉じる').click();
    await until(() => notice() === '');
    expect(notice()).toBe('');
    root.render(<Viewer api={api} document={documentOf()} sectionTarget={target(REV1, 2)} />);
    await until(() => notice() !== '');
    expect(notice()).toContain('この表示では');
  });
});

describe('文書のpathとIDのcopy（仕様13.2）', () => {
  const copyResult = () =>
    container.querySelector('[data-testid="copy-result"]')?.textContent ?? '';
  function mockClipboard(writeText: (text: string) => Promise<void>): void {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  }

  it('文書のpathとIDをcopyし、結果を示す', async () => {
    const copied: string[] = [];
    mockClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    root.render(<Viewer api={api} document={documentOf()} />);
    await until(() => shownText() !== '');
    button('文書のpathをcopy').click();
    await until(() => copyResult() !== '');
    expect(copyResult()).toBe('文書のpathをcopyしました。');
    button('文書のIDをcopy').click();
    await until(() => copyResult() === '文書のIDをcopyしました。');
    expect(copied).toEqual(['a.html', 'doc_1']);
    expect(copyResult()).toBe('文書のIDをcopyしました。');
  });

  it('copyできなかったときは、成功と示さずに理由を示す', async () => {
    mockClipboard(() => Promise.reject(new Error('許可されていません')));
    root.render(<Viewer api={api} document={documentOf()} />);
    await until(() => shownText() !== '');
    button('文書のIDをcopy').click();
    await until(() => copyResult() !== '');
    expect(copyResult()).toBe('文書のIDをcopyできませんでした（許可されていません）。');
  });

  it('stdinから開いた文書には、pathのcopyを出さない', async () => {
    mockClipboard(() => Promise.resolve());
    root.render(
      <Viewer
        api={api}
        document={documentOf({ sourceKind: 'stdin', displayPath: null, pathSegments: [] })}
      />,
    );
    await until(() => shownText() !== '');
    expect(
      [...container.querySelectorAll('button')].some(
        (item) => item.getAttribute('aria-label') === '文書のpathをcopy',
      ),
    ).toBe(false);
  });
});
