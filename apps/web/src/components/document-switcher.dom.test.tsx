// @vitest-environment happy-dom
import { parseMarkdownDocument } from '@vde-open/document';
import type { DocumentSummary, RenderGrantResult } from '@vde-open/shared';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DocumentSwitcher } from '@/components/document-workspace';
import type { Api } from '@/lib/api';
import { documentAt } from '@/lib/document.fixture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const workers: ControlledWorker[] = [];
class ControlledWorker extends EventTarget {
  source = '';
  terminated = false;
  constructor() {
    super();
    workers.push(this);
  }
  postMessage(message: { source: string }) {
    this.source = message.source;
  }
  terminate() {
    this.terminated = true;
  }
  finish() {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: { id: 1, ok: true, document: parseMarkdownDocument(this.source) },
      }),
    );
  }
}

let container: HTMLElement;
let root: Root;
let documents: DocumentSummary[];
let bodies: ReturnType<typeof deferred<string>>[];
let grants: ReturnType<typeof deferred<RenderGrantResult>>[];
let api: Api;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await settle();
  expect(condition()).toBe(true);
}

function grant(index: number): RenderGrantResult {
  const document = documents[index]!;
  return {
    grant: `g${index}`,
    documentId: document.documentId,
    revision: document.revision!,
    format: document.format,
    mode: 'static',
    documentUrl: `about:blank#${index}`,
    filesBaseUrl: 'about:blank',
    documentLogicalPath: `${index}.md`,
    assets: [],
    links: [],
    diagnostics: [],
    headingTargets: [],
    bridge: null,
  };
}

function show(index: number) {
  root.render(
    <DocumentSwitcher
      api={api}
      documents={documents}
      document={documents[index]!}
      feedbackSignal={0}
      renderSignal={0}
    />,
  );
}

const surface = () =>
  container.querySelector('[data-testid="document-workspace"][aria-hidden="false"]')!;

beforeEach(() => {
  workers.length = 0;
  vi.stubGlobal('Worker', ControlledWorker);
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  documents = ['first', 'second', 'third'].map((name, index) => ({
    ...documentAt(`/${name}.md`, null, name),
    revision: `rev_${String(index + 1).repeat(64)}`,
  }));
  bodies = documents.map(() => deferred<string>());
  grants = documents.map(() => deferred<RenderGrantResult>());
  api = {
    content: (id: string) =>
      bodies[documents.findIndex((document) => document.documentId === id)]!.promise,
    outline: () => Promise.resolve([]),
    renderGrant: (id: string) =>
      grants[documents.findIndex((document) => document.documentId === id)]!.promise,
    releaseGrants: vi.fn<Api['releaseGrants']>(() => Promise.resolve()),
    renderMissing: () => Promise.resolve([]),
  } as unknown as Api;
});

afterEach(() => {
  root.unmount();
  container.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

async function firstMarkdown() {
  show(0);
  bodies[0]!.resolve('# First\n\n**original**');
  grants[0]!.resolve(grant(0));
  await until(() => workers.length === 1);
  workers[0]!.finish();
  await until(() => surface().querySelector('article') !== null);
}

it('keeps the current preview and its scroll position until the next body, parse, and assets are ready', async () => {
  await firstMarkdown();
  const previous = surface();
  const scroller = previous.querySelector('[data-testid="document-body"]')!;
  scroller.scrollTop = 150;
  show(1);
  await until(() => container.querySelectorAll('[data-testid="document-workspace"]').length === 2);
  expect(surface()).toBe(previous);
  expect(scroller.scrollTop).toBe(150);
  expect(previous.hasAttribute('inert')).toBe(true);
  expect(surface().querySelector('article')?.textContent).toContain('original');

  bodies[1]!.resolve('# Second\n\n**replacement**');
  await until(() => workers.length === 2);
  expect(container.querySelector('pre')).toBeNull();
  workers[1]!.finish();
  await settle();
  expect(surface()).toBe(previous);
  grants[1]!.resolve(grant(1));
  await until(() => surface().querySelector('article strong')?.textContent === 'replacement');
  expect(container.querySelectorAll('[data-testid="document-workspace"]')).toHaveLength(1);
  expect(surface().hasAttribute('inert')).toBe(false);
  expect(surface().textContent).not.toContain('Loading…');
  expect(api.releaseGrants).toHaveBeenCalledWith(['g0']);
});

it('discards an unfinished selection and ignores its late result', async () => {
  await firstMarkdown();
  show(1);
  bodies[1]!.resolve('# Second');
  await until(() => workers.length === 2);
  show(2);
  await until(() => workers[1]!.terminated);
  workers[1]!.finish();
  grants[1]!.resolve(grant(1));
  await settle();
  expect(surface().textContent).toContain('original');
  bodies[2]!.resolve('# Third');
  grants[2]!.resolve(grant(2));
  await until(() => workers.length === 3);
  workers[2]!.finish();
  await until(() => surface().querySelector('article')?.textContent === 'Third');
  expect(surface().textContent).not.toContain('Second');
  expect(api.releaseGrants).toHaveBeenCalledWith(['g1']);
});

it('returning to the shown document cancels preparation without recreating the view', async () => {
  await firstMarkdown();
  const previous = surface();
  show(1);
  await until(() => container.querySelectorAll('[data-testid="document-workspace"]').length === 2);
  show(0);
  await until(() => container.querySelectorAll('[data-testid="document-workspace"]').length === 1);
  expect(surface()).toBe(previous);
  expect(surface().querySelector('article')?.textContent).toContain('original');
  expect(api.releaseGrants).not.toHaveBeenCalled();
});

it('shows a load failure instead of keeping the previous document indefinitely', async () => {
  await firstMarkdown();
  show(1);
  await until(() => container.querySelectorAll('[data-testid="document-workspace"]').length === 2);
  bodies[1]!.reject(new Error('content unavailable'));
  await until(() => surface().textContent?.includes('content unavailable') === true);
  expect(surface().textContent).not.toContain('original');
});

it('shows the existing parse failure and source without waiting for preview assets', async () => {
  await firstMarkdown();
  show(1);
  bodies[1]!.resolve('# Second');
  await until(() => workers.length === 2);
  workers[1]!.dispatchEvent(
    new MessageEvent('message', {
      data: { id: 1, ok: false, reason: 'limit-nodes' },
    }),
  );
  await until(() => surface().querySelector('pre')?.textContent === '# Second');
  expect(surface().textContent).toContain('more than 100,000 elements');
  expect(surface().textContent).not.toContain('original');
});
