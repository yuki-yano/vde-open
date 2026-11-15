// @vitest-environment happy-dom
import type {
  DocumentSummary,
  FeedbackForAgent,
  FeedbackForUi,
  RenderGrantResult,
  ServerEvent,
} from '@vde-open/shared';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Workspace } from '@/App';
import type { Api } from '@/lib/api';

// The list of questions awaiting an answer across the open documents, above the document list.

const REV = `rev_${'1'.repeat(64)}`;
const requestIdOf = (n: number) => `req_0000000${String(n)}-0000-4000-8000-000000000000`;

function documentOf(n: number, title: string): DocumentSummary {
  return {
    documentId: `doc_${String(n)}`,
    key: null,
    format: 'html',
    sourceKind: 'file',
    title,
    displayPath: `/work/${title}.html`,
    pathSegments: ['work', `${title}.html`],
    canonicalPath: `/work/${title}.html`,
    repository: null,
    revision: REV,
    sourceState: 'ready',
    searchState: 'ready',
    openedAt: '',
    updatedAt: '',
    order: n,
    pendingRequestIds: [],
    htmlMode: 'static',
    interactiveAllowed: false,
  };
}

function questionOn(
  document: DocumentSummary,
  n: number,
  title: string,
  createdAt = new Date().toISOString(),
): FeedbackForAgent {
  return {
    requestId: requestIdOf(n),
    documentId: document.documentId,
    revision: REV,
    title,
    status: 'pending',
    createdAt,
    submission: null,
    cancellation: null,
    acknowledgedAt: null,
  };
}

const docA = documentOf(1, 'alpha');
const docB = documentOf(2, 'beta');
const docC = documentOf(3, 'gamma');

let container: HTMLElement;
let root: Root;
// The daemon's state. Each fetch answers with the state at the time it started.
let server: { documents: DocumentSummary[]; pending: FeedbackForAgent[] };
// Fetches of the pending questions can be held back (finished later) or fail.
let fetches: { hold: boolean; held: Array<() => void>; fail: boolean };
let handlers: { onEvent: (event: ServerEvent) => void; onConnect: () => void } | null;
let sequence: number;
let api: Api;

function withPending(documents: DocumentSummary[], pending: FeedbackForAgent[]) {
  return documents.map((document) => ({
    ...document,
    pendingRequestIds: pending
      .filter((request) => request.documentId === document.documentId)
      .map((request) => request.requestId),
  }));
}

function setServer(documents: DocumentSummary[], pending: FeedbackForAgent[]) {
  server = { documents: withPending(documents, pending), pending };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  window.localStorage.setItem('vde-open.pref.view-mode', JSON.stringify('source'));
  setServer([docA, docB, docC], []);
  fetches = { hold: false, held: [], fail: false };
  handlers = null;
  sequence = 0;
  api = {
    content: () => Promise.resolve('body'),
    outline: () => Promise.resolve([]),
    renderGrant: () => new Promise<RenderGrantResult>(() => undefined),
    feedbackRenderGrant: () => new Promise<RenderGrantResult>(() => undefined),
    releaseGrants: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    documents: () =>
      Promise.resolve({ documents: server.documents, catalogVersion: 1, cursor: null }),
    status: () => Promise.resolve({ activeDocumentId: docA.documentId }),
    feedback: (requestId: string) => {
      const request = server.pending.find((item) => item.requestId === requestId);
      if (!request) return Promise.reject(new Error('not found'));
      return Promise.resolve({
        ...request,
        questionnaire: {
          schemaVersion: 1,
          title: request.title,
          fieldOrder: ['verdict'],
          answerSchema: {
            type: 'object',
            properties: { verdict: { type: 'string', title: 'Verdict', enum: ['OK', 'NG'] } },
            required: ['verdict'],
            additionalProperties: false,
          },
        },
        renderMode: 'static',
        draftVersion: 0,
        draftAnswers: {},
        currentRevision: REV,
        documentOpen: true,
      } satisfies FeedbackForUi);
    },
    pendingFeedback: () => {
      if (fetches.fail) return Promise.reject(new Error('offline'));
      const snapshot = server.pending;
      if (!fetches.hold) return Promise.resolve(snapshot);
      return new Promise((resolve) => fetches.held.push(() => resolve(snapshot)));
    },
    events: (next: NonNullable<typeof handlers>) => {
      handlers = next;
      return { close: () => undefined };
    },
  } as unknown as Api;
});

afterEach(() => {
  vi.useRealTimers();
  root.unmount();
  container.remove();
  window.localStorage.clear();
});

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await settle(10);
}

function notify(type: ServerEvent['type'] = 'feedback-changed') {
  sequence += 1;
  handlers?.onEvent({ type, daemonId: 'd1', sequence, catalogVersion: 1 } as ServerEvent);
}

// Show the workspace and connect to the daemon's notifications.
async function connect() {
  root.render(<Workspace api={api} />);
  await until(() => handlers !== null);
  handlers?.onConnect();
  notify('hello');
}

const section = () =>
  [...container.querySelectorAll('section')].find((item) =>
    item.querySelector('h2')?.textContent?.startsWith('Waiting for your answer'),
  ) ?? null;
// The count is kept apart from the heading text by a no-break space.
const heading = () => section()?.querySelector('h2')?.textContent?.replace(/\s+/g, ' ') ?? null;
const rowButtons = () => [
  ...(section()?.querySelectorAll<HTMLButtonElement>('button[data-request-id]') ?? []),
];
const shownRows = () =>
  rowButtons().map((row) => [
    row.querySelector('[data-part="question"]')?.textContent,
    row.querySelector('[data-part="document"]')?.textContent,
  ]);
const failure = () => section()?.querySelector('[role="status"]')?.textContent ?? null;
const panelTitle = () =>
  container.querySelector('aside[aria-label="Answer the question"] h2')?.textContent ?? null;
const documentRow = (document: DocumentSummary) =>
  container.querySelector<HTMLButtonElement>(`button[data-document-id="${document.documentId}"]`);

describe('questions awaiting an answer', () => {
  it('lists each question with its document, and one whose document is not listed yet appears once the list has it', async () => {
    const docD = documentOf(4, 'delta');
    setServer([docA, docB], [questionOn(docB, 1, 'Pick a layout'), questionOn(docD, 2, 'Name')]);
    await connect();
    await until(() => rowButtons().length === 1);
    expect(shownRows()).toEqual([['Pick a layout', 'beta']]);
    expect(heading()).toBe('Waiting for your answer (1)');
    // The name is the question; the document and its location are its description.
    const [row] = rowButtons();
    expect(row?.textContent).toContain('Pick a layout');
    const description = document.getElementById(row?.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe('beta. /work/beta.html. Asked just now.');

    setServer([docA, docB, docD], server.pending);
    notify('catalog-changed');
    await until(() => rowButtons().length === 2);
    expect(shownRows()).toEqual([
      ['Pick a layout', 'beta'],
      ['Name', 'delta'],
    ]);
    expect(heading()).toBe('Waiting for your answer (2)');
  });

  it('shows nothing while no question is waiting', async () => {
    await connect();
    await until(() => documentRow(docA) !== null);
    await settle();
    expect(section()).toBeNull();
  });

  it('pressing a row shows that document with its question in the answer panel', async () => {
    setServer(
      [docA, docB, docC],
      [questionOn(docA, 1, 'Question on alpha'), questionOn(docC, 2, 'Question on gamma')],
    );
    await connect();
    await until(() => panelTitle() === 'Question on alpha');
    await until(() => rowButtons().length === 2);
    rowButtons()[1]?.click();
    await until(() => panelTitle() === 'Question on gamma');
    expect(panelTitle()).toBe('Question on gamma');
    expect(documentRow(docC)?.getAttribute('aria-current')).toBe('true');
    expect(rowButtons().map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true']);
  });

  it('a slow response never brings back a question that a later fetch no longer has', async () => {
    fetches.hold = true;
    setServer([docA, docB], [questionOn(docB, 1, 'Old question')]);
    await connect();
    // The question is answered while the first fetches are still on their way.
    setServer([docA, docB], [questionOn(docA, 2, 'New question')]);
    notify();
    // Let every fetch the notifications ask for start before any finishes.
    await settle(50);
    for (let round = 0; round < 10; round += 1) {
      // Finish the newest fetch first, as a parallel fetch could.
      fetches.held.pop()?.();
      await settle();
    }
    await until(() => rowButtons().length === 1);
    await settle();
    expect(shownRows()).toEqual([['New question', 'alpha']]);
  });

  it('keeps the last list and says so when a fetch fails, until a fetch succeeds', async () => {
    setServer([docA, docB], [questionOn(docB, 1, 'Pick a layout')]);
    await connect();
    await until(() => rowButtons().length === 1);

    fetches.fail = true;
    notify();
    await until(() => failure() !== null);
    expect(failure()).toBe('Could not fetch the latest questions.');
    expect(shownRows()).toEqual([['Pick a layout', 'beta']]);

    fetches.fail = false;
    notify();
    await until(() => failure() === null);
    expect(shownRows()).toEqual([['Pick a layout', 'beta']]);
  });

  it('says so even when the failed fetch is the first', async () => {
    fetches.fail = true;
    await connect();
    await until(() => failure() !== null);
    expect(heading()).toBe('Waiting for your answer (0)');
    expect(failure()).toBe('Could not fetch the latest questions.');
  });

  it('shows the same list in the Tree layout', async () => {
    window.localStorage.setItem('vde-open.pref.sidebar-view', JSON.stringify('tree'));
    setServer([docA, docB], [questionOn(docB, 1, 'Pick a layout')]);
    await connect();
    await until(() => rowButtons().length === 1);
    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    expect(shownRows()).toEqual([['Pick a layout', 'beta']]);
  });

  it('counts how long each question has waited, with one timer for the list', async () => {
    // The clock still moves with real time, so the waits below can time out.
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval'],
      shouldAdvanceTime: true,
    });
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    setServer(
      [docA, docB, docC],
      [
        questionOn(docA, 1, 'q1', minutesAgo(0.5)),
        questionOn(docB, 2, 'q2', minutesAgo(5)),
        questionOn(docC, 3, 'q3', minutesAgo(3 * 60 + 5)),
      ],
    );
    await connect();
    const elapsed = () =>
      rowButtons().map((row) => row.querySelector('[data-part="elapsed"]')?.textContent);
    await until(() => rowButtons().length === 3);
    expect(elapsed()).toEqual(['just now', '5m ago', '3h ago']);
    const timersWithRows = vi.getTimerCount();
    vi.advanceTimersByTime(60_000);
    await until(() => elapsed()[0] === '1m ago');
    expect(elapsed()).toEqual(['1m ago', '6m ago', '3h ago']);

    // Three rows share one timer, and it stops once no question is left.
    setServer([docA, docB, docC], []);
    notify();
    await until(() => section() === null);
    await until(() => vi.getTimerCount() < timersWithRows);
    expect(timersWithRows - vi.getTimerCount()).toBe(1);
  });

  it('moves keyboard focus to the next question when the focused one goes away, then to its document', async () => {
    setServer([docA, docB], [questionOn(docA, 1, 'First'), questionOn(docB, 2, 'Second')]);
    await connect();
    await until(() => rowButtons().length === 2);
    rowButtons()[0]?.focus();

    setServer([docA, docB], [questionOn(docB, 2, 'Second')]);
    notify();
    await until(() => rowButtons().length === 1);
    expect(document.activeElement).toBe(rowButtons()[0]);

    setServer([docA, docB], []);
    notify();
    await until(() => section() === null);
    expect(document.activeElement).toBe(documentRow(docB));
  });

  it('leaves focus that moved elsewhere where it is', async () => {
    setServer([docA, docB], [questionOn(docA, 1, 'First'), questionOn(docB, 2, 'Second')]);
    await connect();
    await until(() => rowButtons().length === 2);
    rowButtons()[0]?.focus();
    documentRow(docB)?.focus();
    await settle();

    setServer([docA, docB], [questionOn(docB, 2, 'Second')]);
    notify();
    await until(() => rowButtons().length === 1);
    await settle();
    expect(document.activeElement).toBe(documentRow(docB));
  });
});
