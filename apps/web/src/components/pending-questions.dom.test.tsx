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

// The lists of questions awaiting an answer and of answers the agent has not picked up, across the open documents,
// above the document list.

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

// A question whose answer was submitted at submittedAt and that the agent has not acknowledged.
function answeredOn(
  document: DocumentSummary,
  n: number,
  title: string,
  submittedAt = new Date().toISOString(),
): FeedbackForAgent {
  return {
    ...questionOn(document, n, title, '2026-01-01T00:00:00.000Z'),
    status: 'submitted',
    submission: {
      submissionId: `sub_0000000${String(n)}-0000-4000-8000-000000000000`,
      answers: { verdict: 'OK' },
      submittedAt,
      revision: REV,
      confirmedAgainstOlderRevision: false,
      currentRevisionAtSubmit: REV,
    },
  };
}

const docA = documentOf(1, 'alpha');
const docB = documentOf(2, 'beta');
const docC = documentOf(3, 'gamma');

let container: HTMLElement;
let root: Root;
// The daemon's state. Each fetch answers with the state at the time it started.
let server: {
  documents: DocumentSummary[];
  pending: FeedbackForAgent[];
  unacknowledged: FeedbackForAgent[];
};
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

function setServer(
  documents: DocumentSummary[],
  pending: FeedbackForAgent[],
  unacknowledged: FeedbackForAgent[] = [],
) {
  server = { documents: withPending(documents, pending), pending, unacknowledged };
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
    unacknowledgedFeedback: () => Promise.resolve(server.unacknowledged),
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
  expect(condition()).toBe(true);
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

const WAITING = 'Waiting for your answer';
const ANSWERED = 'Answered, agent has not picked up';
const section = (name = WAITING) =>
  [...container.querySelectorAll('section')].find((item) =>
    item.querySelector('h2')?.textContent?.startsWith(name),
  ) ?? null;
// The count is kept apart from the heading text by a no-break space.
const heading = (name = WAITING) =>
  section(name)?.querySelector('h2')?.textContent?.replace(/\s+/g, ' ') ?? null;
const rowButtons = (name = WAITING) => [
  ...(section(name)?.querySelectorAll<HTMLButtonElement>('button[data-request-id]') ?? []),
];
const shownRows = (name = WAITING) =>
  rowButtons(name).map((row) => [
    row.querySelector('[data-part="question"]')?.textContent,
    row.querySelector('[data-part="document"]')?.textContent,
  ]);
const elapsedOf = (name = WAITING) =>
  rowButtons(name).map((row) => row.querySelector('[data-part="elapsed"]')?.textContent);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
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

  it('keeps the last lists and says so once when a fetch fails, until a fetch succeeds', async () => {
    setServer([docA, docB], [questionOn(docB, 1, 'Pick a layout')], [answeredOn(docA, 2, 'Done')]);
    await connect();
    await until(() => rowButtons().length === 1 && rowButtons(ANSWERED).length === 1);

    fetches.fail = true;
    notify();
    await until(() => failure() !== null);
    expect(failure()).toBe('Could not fetch the latest questions.');
    expect(shownRows()).toEqual([['Pick a layout', 'beta']]);
    expect(shownRows(ANSWERED)).toEqual([['Done', 'alpha']]);
    expect(section(ANSWERED)?.querySelector('[role="status"]')).toBeNull();

    fetches.fail = false;
    notify();
    await until(() => failure() === null);
    expect(shownRows()).toEqual([['Pick a layout', 'beta']]);
    expect(shownRows(ANSWERED)).toEqual([['Done', 'alpha']]);
  });

  it('says so even when the failed fetch is the first', async () => {
    fetches.fail = true;
    await connect();
    await until(() => failure() !== null);
    expect(heading()).toBe('Waiting for your answer (0)');
    expect(failure()).toBe('Could not fetch the latest questions.');
  });

  it('shows the same lists in the Tree layout', async () => {
    window.localStorage.setItem('vde-open.pref.sidebar-view', JSON.stringify('tree'));
    setServer([docA, docB], [questionOn(docB, 1, 'Pick a layout')], [answeredOn(docA, 2, 'Done')]);
    await connect();
    await until(() => rowButtons().length === 1 && rowButtons(ANSWERED).length === 1);
    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    expect(shownRows()).toEqual([['Pick a layout', 'beta']]);
    expect(shownRows(ANSWERED)).toEqual([['Done', 'alpha']]);
  });

  it('counts how long each question has waited, with one timer for both lists', async () => {
    // The clock still moves with real time, so the waits below can time out.
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval'],
      shouldAdvanceTime: true,
    });
    setServer(
      [docA, docB, docC],
      [
        questionOn(docA, 1, 'q1', minutesAgo(0.5)),
        questionOn(docB, 2, 'q2', minutesAgo(5)),
        questionOn(docC, 3, 'q3', minutesAgo(3 * 60 + 5)),
      ],
      [answeredOn(docA, 4, 'q4', minutesAgo(2))],
    );
    await connect();
    await until(() => rowButtons().length === 3);
    expect(elapsedOf()).toEqual(['just now', '5m ago', '3h ago']);
    expect(elapsedOf(ANSWERED)).toEqual(['answered 2m ago']);
    const timersWithRows = vi.getTimerCount();
    vi.advanceTimersByTime(60_000);
    await until(() => elapsedOf()[0] === '1m ago');
    expect(elapsedOf()).toEqual(['1m ago', '6m ago', '3h ago']);
    expect(elapsedOf(ANSWERED)).toEqual(['answered 3m ago']);

    // Four rows in two lists share one timer, and it stops once no question is left.
    setServer([docA, docB, docC], []);
    notify();
    await until(() => section() === null && section(ANSWERED) === null);
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

describe('answers the agent has not picked up', () => {
  it('lists each answer of the last 24 hours with its document, oldest answer first', async () => {
    const docD = documentOf(4, 'delta');
    setServer(
      [docA, docB, docC],
      [],
      [
        answeredOn(docB, 1, 'Later answer', minutesAgo(2)),
        answeredOn(docA, 2, 'Earlier answer', minutesAgo(10)),
        answeredOn(docC, 3, 'Day-old answer', minutesAgo(24 * 60 + 1)),
        answeredOn(docD, 4, 'Answer on a document not listed'),
      ],
    );
    await connect();
    await until(() => rowButtons(ANSWERED).length === 2);
    expect(heading(ANSWERED)).toBe('Answered, agent has not picked up (2)');
    expect(shownRows(ANSWERED)).toEqual([
      ['Earlier answer', 'alpha'],
      ['Later answer', 'beta'],
    ]);
    expect(elapsedOf(ANSWERED)).toEqual(['answered 10m ago', 'answered 2m ago']);
    const [row] = rowButtons(ANSWERED);
    const description = document.getElementById(row?.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe('alpha. /work/alpha.html. Answered 10m ago.');
    expect(section()).toBeNull();

    row?.click();
    await until(() => documentRow(docA)?.getAttribute('aria-current') === 'true');
    expect(row?.getAttribute('aria-current')).toBe('true');
  });

  it('a submitted question moves here from the questions awaiting an answer, and leaves once the agent acknowledges it', async () => {
    setServer([docA, docB], [questionOn(docB, 1, 'Pick a layout')]);
    await connect();
    await until(() => rowButtons().length === 1);
    expect(section(ANSWERED)).toBeNull();

    setServer([docA, docB], [], [answeredOn(docB, 1, 'Pick a layout')]);
    notify();
    await until(() => rowButtons(ANSWERED).length === 1);
    expect(section()).toBeNull();
    expect(shownRows(ANSWERED)).toEqual([['Pick a layout', 'beta']]);

    setServer([docA, docB], []);
    notify();
    await until(() => section(ANSWERED) === null);
    expect(section(ANSWERED)).toBeNull();
  });

  it('drops an answer once it is more than 24 hours old, without a refetch', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval'],
      shouldAdvanceTime: true,
    });
    setServer([docA], [], [answeredOn(docA, 1, 'Almost a day', minutesAgo(24 * 60 - 1))]);
    await connect();
    await until(() => rowButtons(ANSWERED).length === 1);
    expect(elapsedOf(ANSWERED)).toEqual(['answered 23h ago']);

    vi.advanceTimersByTime(90_000);
    await until(() => section(ANSWERED) === null);
    expect(section(ANSWERED)).toBeNull();
  });
});
