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
// Revisions whose body was fetched.
let contentRequests: string[];
// The daemon's current state (returned by the fake API).
let current: { documents: DocumentSummary[]; request: FeedbackForUi };
let feedbackRequests: number;
let handlers: { onEvent: (event: ServerEvent) => void; onConnect: () => void } | null;
let api: Api;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  // Use the Source view so the fetched body is shown as is.
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
// Wait until the condition holds. Under the load of tests running in parallel, screen updates take time.
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await settle(10);
}
const shownText = () => container.querySelector('pre')?.textContent ?? '';
function button(text: string): HTMLButtonElement {
  // Icon-only buttons are found by aria-label.
  const found = [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.includes(text) || item.getAttribute('aria-label') === text,
  );
  if (!found) throw new Error(`Button "${text}" not found`);
  return found;
}
const statusText = () =>
  container.querySelector('[data-testid="feedback-status"]')?.textContent ?? '';

describe('FB-015 showing the revision awaiting an answer', () => {
  it("the question's revision takes precedence over pausing updates, and pausing cannot be toggled meanwhile", async () => {
    const document = documentOf({ revision: REV2 });
    root.render(<Viewer api={api} document={document} fixedRevision={REV1} />);
    await until(() => shownText() !== '');
    expect(shownText()).toBe('本文 1');
    const pause = button('Pause updates');
    expect(pause.disabled).toBe(true);
    pause.click();
    await settle();
    expect(shownText()).toBe('本文 1');
    expect(contentRequests).toEqual([REV1]);
    expect(container.textContent).toContain("Showing the question's revision");
  });

  it("shows the question's revision even if updates were paused before the question", async () => {
    root.render(<Viewer api={api} document={documentOf()} fixedRevision={null} />);
    await until(() => shownText() !== '');
    button('Pause updates').click();
    await settle();
    // While paused, a new revision was created and a question arrived for that revision.
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

describe('SYS-013 notification reconnect and question refetch', () => {
  async function showPendingQuestion(): Promise<void> {
    current.documents = [documentOf({ pendingRequestIds: [REQUEST_ID] })];
    root.render(<Workspace api={api} />);
    await settle();
    handlers?.onConnect();
    handlers?.onEvent({ type: 'hello', daemonId: 'd1', sequence: 1, catalogVersion: 1 });
    await until(() => statusText() !== '');
    expect(statusText()).toBe('Not answered');
  }

  // The question was cancelled while disconnected.
  function cancelWhileDisconnected(): number {
    current.documents = [documentOf()];
    current.request = requestOf({
      status: 'cancelled',
      cancellation: { reason: 'user_cancelled', cancelledAt: T0 },
    } as Partial<FeedbackForUi>);
    return feedbackRequests;
  }

  it('refetches the shown question after reconnecting', async () => {
    await showPendingQuestion();
    const before = cancelWhileDisconnected();
    handlers?.onConnect();
    handlers?.onEvent({ type: 'hello', daemonId: 'd1', sequence: 1, catalogVersion: 1 });
    await until(() => statusText() === 'Cancelled');
    expect(feedbackRequests).toBeGreaterThan(before);
    expect(statusText()).toBe('Cancelled');
  });

  it('also refetches when a sequence number is skipped and on resync-required', async () => {
    await showPendingQuestion();
    let before = cancelWhileDisconnected();
    handlers?.onEvent({ type: 'document-status', daemonId: 'd1', sequence: 5, catalogVersion: 1 });
    await until(() => statusText() === 'Cancelled');
    expect(feedbackRequests).toBeGreaterThan(before);
    expect(statusText()).toBe('Cancelled');

    before = feedbackRequests;
    handlers?.onEvent({ type: 'resync-required', daemonId: 'd1', sequence: 6, catalogVersion: 1 });
    await until(() => feedbackRequests > before);
    expect(feedbackRequests).toBeGreaterThan(before);
  });
});

describe("UX-002 the search result's revision and the shown revision", () => {
  const notice = () =>
    container.querySelector('[data-testid="section-target-notice"]')?.textContent ?? '';
  const target = (revision: string, nonce = 1) => ({ sectionId: 'sec_0001', revision, nonce });

  it("while showing the question's revision, does not jump to a newer revision's result, explains why, and keeps the question's revision", async () => {
    root.render(
      <Viewer
        api={api}
        document={documentOf({ revision: REV2 })}
        fixedRevision={REV1}
        sectionTarget={target(REV2)}
      />,
    );
    await until(() => notice() !== '');
    expect(notice()).toContain("showing the question's revision while awaiting an answer");
    expect(shownText()).toBe('本文 1');
    expect(contentRequests).toEqual([REV1]);
  });

  it("does not jump to another revision's result while paused, or after the document was updated since the search", async () => {
    root.render(<Viewer api={api} document={documentOf()} sectionTarget={null} />);
    await until(() => shownText() !== '');
    button('Pause updates').click();
    await settle();
    root.render(
      <Viewer api={api} document={documentOf({ revision: REV2 })} sectionTarget={target(REV2)} />,
    );
    await until(() => notice() !== '');
    expect(notice()).toContain('Updates are paused, so the view did not jump');
    expect(shownText()).toBe('本文 1');

    root.unmount();
    root = createRoot(container);
    root.render(
      <Viewer api={api} document={documentOf({ revision: REV2 })} sectionTarget={target(REV1)} />,
    );
    await until(() => notice() !== '');
    expect(notice()).toContain('The document was updated after the search');
  });

  it('in a view that does not jump even for the same revision, says so, and after dismissing stays hidden until the next jump', async () => {
    root.render(<Viewer api={api} document={documentOf()} sectionTarget={target(REV1)} />);
    await until(() => notice() !== '');
    expect(notice()).toContain('This view does not jump to sections');
    button('Dismiss').click();
    await until(() => notice() === '');
    expect(notice()).toBe('');
    root.render(<Viewer api={api} document={documentOf()} sectionTarget={target(REV1, 2)} />);
    await until(() => notice() !== '');
    expect(notice()).toContain('This view does not jump');
  });
});

describe('copying the document path and ID (spec 13.2)', () => {
  const copyResult = () =>
    container.querySelector('[data-testid="copy-result"]')?.textContent ?? '';
  function mockClipboard(writeText: (text: string) => Promise<void>): void {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  }

  it('copies the document path and ID and shows the result', async () => {
    const copied: string[] = [];
    mockClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    root.render(<Viewer api={api} document={documentOf()} />);
    await until(() => shownText() !== '');
    button('Copy document path').click();
    await until(() => copyResult() !== '');
    expect(copyResult()).toBe('Copied the document path.');
    button('Copy document ID').click();
    await until(() => copyResult() === 'Copied the document ID.');
    expect(copied).toEqual(['a.html', 'doc_1']);
    expect(copyResult()).toBe('Copied the document ID.');
  });

  it('when copying fails, shows the reason instead of reporting success', async () => {
    mockClipboard(() => Promise.reject(new Error('Not allowed')));
    root.render(<Viewer api={api} document={documentOf()} />);
    await until(() => shownText() !== '');
    button('Copy document ID').click();
    await until(() => copyResult() !== '');
    expect(copyResult()).toBe('Could not copy the document ID (Not allowed).');
  });

  it('does not offer copying the path for a document opened from stdin', async () => {
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
        (item) => item.getAttribute('aria-label') === 'Copy document path',
      ),
    ).toBe(false);
  });
});
