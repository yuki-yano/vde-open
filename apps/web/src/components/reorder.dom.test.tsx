// @vitest-environment happy-dom
import type { DocumentSummary, RenderGrantResult, ServerEvent } from '@vde-open/shared';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '@/App';
import type { Api } from '@/lib/api';
import { inRepository } from '@/lib/document.fixture';

// Saving the order of the list: moves are saved one at a time on the latest catalog version,
// and lists fetched while saves are pending keep the order the user set.

let container: HTMLElement;
let root: Root;
let server: { documents: DocumentSummary[]; version: number };
let handlers: { onEvent: (event: ServerEvent) => void; onConnect: () => void } | null;
let saves: Array<{ order: string[]; version: number; finish: (version: number) => void }>;
// Lists can be held back (released later) or fail once.
let lists: { hold: boolean; held: Array<() => void>; failNext: boolean };
let api: Api;

const titled = (title: string) => ({ ...inRepository('/r/app', `${title}.md`), title });

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const documents = ['A', 'B', 'C', 'D'].map(titled);
  server = { documents, version: 1 };
  handlers = null;
  saves = [];
  lists = { hold: false, held: [], failNext: false };
  api = {
    content: () => Promise.resolve('body'),
    outline: () => Promise.resolve([]),
    renderGrant: () => new Promise<RenderGrantResult>(() => undefined),
    feedbackRenderGrant: () => new Promise<RenderGrantResult>(() => undefined),
    releaseGrants: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    documents: () => {
      if (lists.failNext) {
        lists.failNext = false;
        return Promise.reject(new Error('offline'));
      }
      const answer = () => ({
        documents: server.documents,
        catalogVersion: server.version,
        cursor: null,
      });
      if (!lists.hold) return Promise.resolve(answer());
      return new Promise((resolveList) => lists.held.push(() => resolveList(answer())));
    },
    status: () => Promise.resolve({ activeDocumentId: null }),
    feedback: () => new Promise(() => undefined),
    events: (next: NonNullable<typeof handlers>) => {
      handlers = next;
      return { close: () => undefined };
    },
    reorder: (order: string[], version: number) =>
      new Promise<number>((finish) => {
        saves.push({ order, version, finish });
      }),
  } as unknown as Api;
});

afterEach(() => {
  root.unmount();
  container.remove();
});

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await tick(10);
}

const shown = () =>
  [...container.querySelectorAll('nav li [data-part="title"]')].map((title) => title.textContent);
const titleOf = (id: string) =>
  server.documents.find((document) => document.documentId === id)?.title;
const idOf = (title: string) =>
  server.documents.find((document) => document.title === title)?.documentId as string;

function moveDown(title: string) {
  const row = container.querySelector(`button[data-document-id="${idOf(title)}"]`);
  row?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
  );
}

// The daemon saved an order: its list changes and it notifies.
let sequence = 0;
function serverSaved(order: string[], version: number) {
  server = {
    documents: order.map((id) => server.documents.find((document) => document.documentId === id)!),
    version,
  };
  sequence += 1;
  handlers?.onEvent({ type: 'catalog-changed', daemonId: 'd', sequence, catalogVersion: version });
}

describe('saving the order', () => {
  it('keeps unsaved moves when a list arrives meanwhile, and saves them in turn', async () => {
    root.render(<Workspace api={api} />);
    await until(() => handlers !== null);
    handlers?.onConnect();
    await until(() => shown().length === 4);

    moveDown('A');
    await until(() => shown().join() === 'B,A,C,D');
    moveDown('A');
    await until(() => shown().join() === 'B,C,A,D');
    expect(saves).toHaveLength(1);

    // The first save lands. Its notification brings a list that does not have the second move yet.
    serverSaved(saves[0]?.order ?? [], 2);
    await tick();
    expect(shown().join()).toBe('B,C,A,D');

    // A further move builds on what is shown.
    moveDown('A');
    await until(() => shown().join() === 'B,C,D,A');

    saves[0]?.finish(2);
    await until(() => saves.length === 2);
    serverSaved(saves[1]?.order ?? [], 3);
    saves[1]?.finish(3);
    await until(() => saves.length === 3);
    serverSaved(saves[2]?.order ?? [], 4);
    saves[2]?.finish(4);
    await tick(50);

    expect(saves.map((save) => [save.order.map(titleOf).join(), save.version])).toEqual([
      ['B,A,C,D', 1],
      ['B,C,A,D', 2],
      ['B,C,D,A', 3],
    ]);
    expect(shown().join()).toBe('B,C,D,A');
  });

  it('never sends an older catalog version than a list already showed', async () => {
    root.render(<Workspace api={api} />);
    await until(() => handlers !== null);
    handlers?.onConnect();
    await until(() => shown().length === 4);

    moveDown('A');
    await until(() => saves.length === 1);
    // The repository of a document changed meanwhile (version 3), and that list arrives before the save answers.
    serverSaved(saves[0]?.order ?? [], 3);
    await tick();
    saves[0]?.finish(2);
    await tick(50);

    moveDown('A');
    await until(() => saves.length === 2);
    expect(saves[1]?.version).toBe(3);
  });

  it('keeps a move made while the list after the saves is still loading', async () => {
    root.render(<Workspace api={api} />);
    await until(() => handlers !== null);
    handlers?.onConnect();
    await until(() => shown().length === 4);

    moveDown('A');
    await until(() => saves.length === 1);
    // The save lands; the list fetched after it is slow.
    lists.hold = true;
    server = {
      documents: ['B', 'A', 'C', 'D'].map((title) =>
        server.documents.find((d) => d.title === title)!,
      ),
      version: 2,
    };
    saves[0]?.finish(2);
    await until(() => lists.held.length > 0);

    moveDown('A');
    await until(() => shown().join() === 'B,C,A,D');
    lists.hold = false;
    for (const release of lists.held.splice(0)) release();
    await tick(50);
    // The slow list did not take the second move back.
    expect(shown().join()).toBe('B,C,A,D');

    moveDown('A');
    await until(() => shown().join() === 'B,C,D,A');
    await until(() => saves.length === 2);
    serverSaved(saves[1]?.order ?? [], 3);
    saves[1]?.finish(3);
    await until(() => saves.length === 3);
    serverSaved(saves[2]?.order ?? [], 4);
    saves[2]?.finish(4);
    await tick(50);
    expect(saves.map((save) => save.order.map(titleOf).join())).toEqual([
      'B,A,C,D',
      'B,C,A,D',
      'B,C,D,A',
    ]);
    expect(shown().join()).toBe('B,C,D,A');
  });

  it('keeps showing the order when the list after the saves fails, until a list arrives', async () => {
    root.render(<Workspace api={api} />);
    await until(() => handlers !== null);
    handlers?.onConnect();
    await until(() => shown().length === 4);

    moveDown('A');
    await until(() => saves.length === 1);
    lists.failNext = true;
    server = {
      documents: ['B', 'A', 'C', 'D'].map((title) =>
        server.documents.find((d) => d.title === title)!,
      ),
      version: 2,
    };
    saves[0]?.finish(2);
    await tick(50);
    expect(shown().join()).toBe('B,A,C,D');

    // Another client moved D to the top; the next list shows the saved state, not the old unsaved order.
    serverSaved(['D', 'B', 'A', 'C'].map(idOf), 3);
    await until(() => shown().join() === 'D,B,A,C');
  });
});
