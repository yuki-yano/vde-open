// @vitest-environment happy-dom
import type { MobileDocument, MobileEvent, MobileGrantResult } from '@vde-open/shared';
import { createRoot, type Root } from 'react-dom/client';
import { parseMarkdownDocument } from '@vde-open/document';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { orderDocuments, type MobileApi } from '@/lib/mobile-api';

import { CLOSED_NOTICE, MobileReader } from './mobile-reader.tsx';

// happy-dom has no Worker: parse on the spot, as the worker would.
vi.mock('@/lib/use-markdown', () => ({
  useMarkdown: (source: string | null) =>
    source === null
      ? { status: 'parsing' }
      : { status: 'ready', document: parseMarkdownDocument(source) },
}));

const REV1 = `rev_${'1'.repeat(64)}`;
const REV2 = `rev_${'2'.repeat(64)}`;
const id = (n: number) => `doc_${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function row(overrides: Partial<MobileDocument> = {}): MobileDocument {
  return {
    documentId: id(1),
    title: 'デモ',
    format: 'html',
    openedAt: '2026-11-18T00:00:00.000Z',
    revision: REV1,
    sourceState: 'ready',
    effectiveMode: 'interactive',
    viewEpoch: '0.0',
    ...overrides,
  };
}

interface Pending {
  viewEpoch: string;
  resolve: (grant: MobileGrantResult) => void;
  reject: (error: Error) => void;
}

let container: HTMLElement;
let root: Root;
let documents: MobileDocument[];
let listFails: boolean;
let grants: Pending[];
let released: Array<{ grants: string[]; keepalive: boolean }>;
let valid: Set<string>;
let handlers: Parameters<MobileApi['events']>[0] | null;
let api: MobileApi;

function grantOf(name: string, viewEpoch = '0.0', mode: 'interactive' | 'static' = 'interactive') {
  return {
    grant: name,
    documentId: id(1),
    revision: REV1,
    viewEpoch,
    format: 'html',
    mode,
    // happy-dom loads frame URLs; the grant name stays visible in the fragment.
    documentUrl: `about:blank#${name}`,
    filesBaseUrl: `https://mac.example.ts.net:43183/r/${name}/files/`,
    documentLogicalPath: 'a.html',
    assets: [],
    links: [],
    headingTargets: [],
  } satisfies MobileGrantResult;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  documents = [row()];
  listFails = false;
  grants = [];
  released = [];
  valid = new Set();
  handlers = null;
  api = {
    documents: () =>
      listFails
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ daemonId: 'd1', documents: orderDocuments(documents) }),
    content: () => Promise.resolve('# text\n'),
    grant: (document) =>
      new Promise<MobileGrantResult>((resolve, reject) => {
        grants.push({ viewEpoch: document.viewEpoch, resolve, reject });
      }),
    check: (grant) => Promise.resolve(valid.has(grant)),
    release: (list, keepalive = false) => {
      released.push({ grants: list, keepalive });
      return Promise.resolve();
    },
    resolveLink: () => Promise.resolve({ status: 'not-open' }),
    events: (next) => {
      handlers = next;
      return { close: () => undefined };
    },
  };
});

afterEach(() => {
  root.unmount();
  container.remove();
});

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await settle(10);
}
const text = () => container.textContent ?? '';
const rows = () =>
  [...container.querySelectorAll('main nav li button')].map((item) => item.textContent);
const frame = () => container.querySelector<HTMLIFrameElement>('[data-testid="document-frame"]');
const paused = () => container.querySelector('[data-testid="frame-paused"]') !== null;
const emit = (event: MobileEvent) => handlers?.onEvent(event);

async function start(): Promise<void> {
  root.render(<MobileReader api={api} />);
  await until(() => handlers !== null);
  handlers?.onConnect();
}
async function showDemo(name = 'g1'): Promise<void> {
  await start();
  await until(() => rows().length > 0);
  (container.querySelector('main nav li button') as HTMLButtonElement).click();
  await until(() => grants.length > 0);
  valid.add(name);
  grants.at(-1)?.resolve(grantOf(name, grants.at(-1)?.viewEpoch));
  await until(() => frame() !== null);
}

describe('the list', () => {
  it('shows the open documents newest opened first, ties by document ID', async () => {
    documents = [
      row({ documentId: id(1), title: '古い', openedAt: '2026-11-18T00:00:00.000Z' }),
      row({ documentId: id(2), title: '新しい', openedAt: '2026-11-18T01:00:00.000Z' }),
      row({ documentId: id(3), title: '同時刻', openedAt: '2026-11-18T00:00:00.000Z' }),
    ];
    await start();
    await until(() => rows().length === 3);
    expect(rows()).toEqual(['新しい', '同時刻', '古い']);
  });

  it('tells waiting, nothing open, and a failed load apart, and retries', async () => {
    listFails = true;
    root.render(<MobileReader api={api} />);
    await until(() => handlers !== null);
    expect(text()).toContain('Connecting to the PC…');
    handlers?.onConnect();
    await until(() => text().includes('Could not load the documents from the PC.'));
    listFails = false;
    documents = [];
    (container.querySelector('button') as HTMLButtonElement).click();
    await until(() => text().includes('No documents are open on the PC.'));
    expect(text()).toContain('No documents are open on the PC.');
  });
});

describe('moving between the list and documents', () => {
  it('a tap adds one history entry; Back returns to the list and Forward to the document', async () => {
    await showDemo();
    expect(new URLSearchParams(window.location.search).get('document')).toBe(id(1));
    const length = window.history.length;
    window.history.back();
    await until(() => rows().length === 1);
    expect(frame()).toBeNull();
    window.history.forward();
    await until(() => frame() !== null);
    expect(window.history.length).toBe(length);
  });

  it('a document closed on the PC returns to the list with the reason, and the URL no longer names it', async () => {
    await showDemo();
    documents = [row({ documentId: id(2), title: '次の文書' })];
    emit({ type: 'changed', daemonId: 'd1' });
    await until(() => text().includes(CLOSED_NOTICE));
    expect(frame()).toBeNull();
    expect(rows()).toEqual(['次の文書']);
    expect(new URLSearchParams(window.location.search).get('document')).toBeNull();
  });
});

describe('keeping the demo only while it is current', () => {
  it('a lost connection stops input; reconnecting with a live grant resumes the same frame', async () => {
    await showDemo();
    const src = frame()?.getAttribute('src');
    expect(paused()).toBe(false);
    handlers?.onDisconnect();
    await until(() => paused());
    expect(frame()?.hasAttribute('inert')).toBe(true);
    handlers?.onConnect();
    await until(() => !paused());
    expect(frame()?.getAttribute('src')).toBe(src);
    expect(grants).toHaveLength(1);
  });

  it('a grant found dead on revalidation removes the frame at once and prepares a new view', async () => {
    await showDemo();
    valid.clear();
    handlers?.onDisconnect();
    handlers?.onConnect();
    await until(() => grants.length === 2);
    expect(frame()).toBeNull();
    grants[1]?.resolve(grantOf('g2'));
    await until(() => frame()?.getAttribute('src')?.includes('g2') === true);
    await until(() => released.some((entry) => entry.grants.includes('g1')));
  });

  it('a new view generation (revoked on the PC) drops the old frame; a late answer for the old one is never shown', async () => {
    await showDemo();
    // A refetch for the same generation is in flight when the permission changes.
    documents = [row({ viewEpoch: '0.1', effectiveMode: 'static' })];
    emit({ type: 'changed', daemonId: 'd1' });
    await until(() => grants.length === 2);
    expect(frame()).toBeNull();
    documents = [row({ viewEpoch: '0.2', effectiveMode: 'interactive' })];
    emit({ type: 'changed', daemonId: 'd1' });
    await until(() => grants.length === 3);
    grants[1]?.resolve(grantOf('late', '0.1', 'static'));
    await until(() => released.some((entry) => entry.grants.includes('late')));
    expect(frame()).toBeNull();
    grants[2]?.resolve(grantOf('g3', '0.2'));
    await until(() => frame()?.getAttribute('src')?.includes('g3') === true);
  });

  it('a new revision in the same mode keeps the old frame until the new one is ready', async () => {
    await showDemo();
    documents = [row({ revision: REV2, viewEpoch: '0.1' })];
    emit({ type: 'changed', daemonId: 'd1' });
    await until(() => grants.length === 2);
    expect(frame()?.getAttribute('src')).toContain('g1');
    grants[1]?.resolve(grantOf('g2', '0.1'));
    await until(() => frame()?.getAttribute('src')?.includes('g2') === true);
    await until(() => released.some((entry) => entry.grants.includes('g1')));
  });

  it('leaving for the history cache releases the view, and coming back prepares a new one', async () => {
    await showDemo();
    window.dispatchEvent(new Event('pagehide'));
    expect(released.at(-1)).toEqual({ grants: ['g1'], keepalive: true });
    window.dispatchEvent(new Event('pageshow'));
    await until(() => grants.length === 2);
    expect(frame()).toBeNull();
  });

  it('a stale list answer (409) while preparing fetches the list again', async () => {
    await start();
    await until(() => rows().length > 0);
    let fetched = 0;
    const documentsOf = api.documents;
    api.documents = () => {
      fetched += 1;
      return documentsOf();
    };
    (container.querySelector('main nav li button') as HTMLButtonElement).click();
    await until(() => grants.length > 0);
    grants[0]?.reject(new ApiError('E_VIEW_STALE', 'stale', 409, {}));
    await until(() => fetched > 0);
    expect(fetched).toBeGreaterThan(0);
  });
});

// A promise resolved or rejected from the test.
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('review follow-ups', () => {
  it('a return (pageshow) stops input until the latest list and the grant check both succeed; a failed list keeps it stopped', async () => {
    await showDemo();
    await until(() => !paused());
    const list = deferred<Awaited<ReturnType<MobileApi['documents']>>>();
    const check = deferred<boolean>();
    api.documents = () => list.promise;
    api.check = () => check.promise;
    window.dispatchEvent(new Event('pageshow'));
    await until(() => paused());
    expect(frame()?.hasAttribute('inert')).toBe(true);
    list.resolve({ daemonId: 'd1', documents: orderDocuments(documents) });
    await settle(60);
    // The list arrived, the check has not: still stopped.
    expect(paused()).toBe(true);
    check.resolve(true);
    await until(() => !paused());
    expect(paused()).toBe(false);

    // A list that cannot be fetched keeps input stopped.
    api.documents = () => Promise.reject(new Error('offline'));
    window.dispatchEvent(new Event('pageshow'));
    await until(() => paused());
    await settle(80);
    expect(paused()).toBe(true);
  });

  it('a saved revision keeps the old frame (without input, not checked) until the new view is ready, although its grant is dead', async () => {
    await showDemo();
    const issue = deferred<MobileGrantResult>();
    api.grant = () => issue.promise;
    // Phone grants need the current revision: the old one is dead from the save on.
    valid.delete('g1');
    documents = [row({ revision: REV2, viewEpoch: '0.1' })];
    emit({ type: 'changed', daemonId: 'd1' });
    await settle(80);
    expect(frame()?.getAttribute('src')).toContain('g1');
    expect(paused()).toBe(true);
    valid.add('g2');
    issue.resolve(grantOf('g2', '0.1'));
    await until(() => frame()?.getAttribute('src')?.includes('g2') === true);
    await until(() => !paused());
    await until(() => released.some((entry) => entry.grants.includes('g1')));
  });

  it('a revoke, a re-grant, and a save while away (several changes, same mode) drop the old frame at once', async () => {
    await showDemo();
    documents = [row({ revision: REV2, viewEpoch: '0.3' })];
    emit({ type: 'changed', daemonId: 'd1' });
    await until(() => grants.length === 2);
    expect(frame()).toBeNull();
  });

  it('a Markdown view keeps its grant while the source loads, and gives it back if the view is left meanwhile', async () => {
    documents = [row({ format: 'markdown', effectiveMode: null, title: 'メモ' })];
    const source = deferred<string>();
    api.content = () => source.promise;
    await start();
    await until(() => rows().length === 1);
    (container.querySelector('main nav li button') as HTMLButtonElement).click();
    await until(() => grants.length === 1);
    valid.add('m1');
    valid.add('m2');
    grants[0]?.resolve(grantOf('m1'));
    await settle();
    // Unrelated screen updates while the source loads do not give the grant back.
    emit({ type: 'changed', daemonId: 'd1', documentId: id(9) });
    await settle(60);
    expect(released.flatMap((entry) => entry.grants)).not.toContain('m1');
    source.resolve('# メモ\n');
    await until(() => text().includes('メモ'));
    expect(released.flatMap((entry) => entry.grants)).not.toContain('m1');

    // Leaving while the next source loads gives that grant back.
    const next = deferred<string>();
    api.content = () => next.promise;
    documents = [
      row({
        format: 'markdown',
        effectiveMode: null,
        title: 'メモ',
        revision: REV2,
        viewEpoch: '0.1',
      }),
    ];
    emit({ type: 'changed', daemonId: 'd1' });
    await until(() => grants.length === 2);
    grants[1]?.resolve(grantOf('m2', '0.1'));
    await settle();
    window.history.back();
    await until(() => rows().length === 1);
    // Given back right away, while its source is still on the way.
    await until(() => released.some((entry) => entry.grants.includes('m2')));
    expect(released.some((entry) => entry.grants.includes('m2'))).toBe(true);
    next.resolve('# 2\n');
  });

  it('a link answer that arrives after Back changes nothing', async () => {
    documents = [
      row({ format: 'markdown', effectiveMode: null, title: 'A' }),
      row({
        documentId: id(2),
        title: 'B',
        format: 'markdown',
        effectiveMode: null,
        openedAt: '2026-11-17T00:00:00.000Z',
      }),
    ];
    api.content = () => Promise.resolve('# A\n\n[Bへ](b.md)\n');
    const answer = deferred<Awaited<ReturnType<MobileApi['resolveLink']>>>();
    api.resolveLink = () => answer.promise;
    await start();
    await until(() => rows().length === 2);
    (container.querySelector('main nav li button') as HTMLButtonElement).click();
    await until(() => grants.length === 1);
    valid.add('a1');
    grants[0]?.resolve({
      ...grantOf('a1'),
      format: 'markdown',
      mode: 'static',
      documentUrl: null,
      links: [{ linkId: 'lnk_0001', href: 'b.md', text: 'Bへ', kind: 'document' }],
    });
    await until(() => container.querySelector('button[data-local-link]') !== null);
    (container.querySelector('button[data-local-link]') as HTMLButtonElement).click();
    window.history.back();
    await until(() => rows().length === 2);
    const length = window.history.length;
    answer.resolve({ status: 'open', documentId: id(2) });
    await settle(60);
    expect(rows()).toHaveLength(2);
    expect(window.history.length).toBe(length);
    expect(text()).not.toContain('Open this document on the PC');
  });

  it('a change to another document refreshes the list without stopping the demo or checking its grant again', async () => {
    await showDemo();
    await until(() => !paused());
    let checks = 0;
    const held = deferred<boolean>();
    api.check = () => {
      checks += 1;
      return held.promise;
    };
    let lists = 0;
    const documentsOf = api.documents;
    api.documents = () => {
      lists += 1;
      return documentsOf();
    };
    emit({ type: 'changed', daemonId: 'd1', documentId: id(9) });
    await until(() => lists > 0);
    await settle(80);
    expect(paused()).toBe(false);
    expect(checks).toBe(0);
  });

  it('after following a link, the back button still returns to the list', async () => {
    documents = [
      row({ format: 'markdown', effectiveMode: null, title: 'A' }),
      row({
        documentId: id(2),
        title: 'B',
        format: 'markdown',
        effectiveMode: null,
        openedAt: '2026-11-17T00:00:00.000Z',
      }),
    ];
    api.content = () => Promise.resolve('# A\n\n[Bへ](b.md)\n');
    api.resolveLink = () => Promise.resolve({ status: 'open', documentId: id(2) });
    api.grant = (document) => {
      const name = `link-${document.documentId.slice(-1)}-${String(grants.length)}`;
      grants.push({
        viewEpoch: document.viewEpoch,
        resolve: () => undefined,
        reject: () => undefined,
      });
      valid.add(name);
      return Promise.resolve({
        ...grantOf(name),
        documentId: document.documentId,
        format: 'markdown',
        mode: 'static',
        documentUrl: null,
        links: [{ linkId: 'lnk_0001', href: 'b.md', text: 'Bへ', kind: 'document' }],
      });
    };
    await start();
    await until(() => rows().length === 2);
    (container.querySelector('main nav li button') as HTMLButtonElement).click();
    await until(() => container.querySelector('button[data-local-link]') !== null);
    (container.querySelector('button[data-local-link]') as HTMLButtonElement).click();
    await until(() => new URLSearchParams(window.location.search).get('document') === id(2));
    (
      container.querySelector('button[aria-label="Back to the documents"]') as HTMLButtonElement
    ).click();
    await until(() => rows().length === 2);
    expect(new URLSearchParams(window.location.search).get('document')).toBeNull();
  });

  it('a document opened directly by URL goes to the list from its own back button', async () => {
    window.history.replaceState(null, '', `/?document=${id(1)}`);
    await start();
    await until(() => grants.length === 1);
    valid.add('g1');
    grants[0]?.resolve(grantOf('g1'));
    await until(() => frame() !== null);
    const length = window.history.length;
    (
      container.querySelector('button[aria-label="Back to the documents"]') as HTMLButtonElement
    ).click();
    await until(() => rows().length === 1);
    expect(new URLSearchParams(window.location.search).get('document')).toBeNull();
    // A new list entry, not history.back() (which would leave the site from a directly opened URL).
    expect(window.history.length).toBe(length + 1);
  });
});

describe('the document drawer and static frames', () => {
  it('switches documents from the drawer (marking the shown one), and Back returns to the previous document', async () => {
    documents = [
      row({ title: 'A' }),
      row({ documentId: id(2), title: 'B', openedAt: '2026-11-17T00:00:00.000Z' }),
    ];
    await showDemo('ga');
    const toggle = container.querySelector(
      'button[aria-label="Switch document"]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('mobile-document-list');
    toggle.click();
    await until(() => toggle.getAttribute('aria-expanded') === 'true');
    const drawer = container.querySelector('#mobile-document-list') as HTMLElement;
    const items = [...drawer.querySelectorAll('li button')];
    expect(items.map((item) => item.textContent)).toEqual(['A', 'B']);
    expect(items[0]?.getAttribute('aria-current')).toBe('page');
    (items[1] as HTMLButtonElement).click();
    await until(() => new URLSearchParams(window.location.search).get('document') === id(2));
    expect(toggle.isConnected ? toggle.getAttribute('aria-expanded') : 'false').toBe('false');
    expect(container.querySelector('h1')?.textContent).toBe('B');
    window.history.back();
    await until(() => container.querySelector('h1')?.textContent === 'A');
    expect(new URLSearchParams(window.location.search).get('document')).toBe(id(1));
  });

  it('a static frame stays scrollable while the view is checked again; only an interactive frame is blocked', async () => {
    documents = [row({ effectiveMode: 'static' })];
    await start();
    await until(() => rows().length > 0);
    (container.querySelector('main nav li button') as HTMLButtonElement).click();
    await until(() => grants.length > 0);
    valid.add('s1');
    grants[0]?.resolve(grantOf('s1', '0.0', 'static'));
    await until(() => frame() !== null);
    api.documents = () => new Promise(() => undefined);
    window.dispatchEvent(new Event('pageshow'));
    await settle(60);
    expect(paused()).toBe(false);
    expect(frame()?.hasAttribute('inert')).toBe(false);
  });
});

describe('drawer review follow-ups', () => {
  const toggleOf = () =>
    container.querySelector('button[aria-label="Switch document"]') as HTMLButtonElement | null;
  const drawerHidden = () =>
    (container.querySelector('#mobile-document-list') as HTMLElement | null)?.classList.contains(
      'hidden',
    ) ?? true;

  it('going back to the list from a directly opened document closes the drawer; the next document starts with it closed', async () => {
    documents = [
      row({ title: 'A' }),
      row({ documentId: id(2), title: 'B', openedAt: '2026-11-17T00:00:00.000Z' }),
    ];
    window.history.replaceState(null, '', `/?document=${id(1)}`);
    await start();
    await until(() => grants.length === 1);
    valid.add('a');
    grants[0]?.resolve(grantOf('a'));
    await until(() => frame() !== null);
    toggleOf()?.click();
    await until(() => toggleOf()?.getAttribute('aria-expanded') === 'true');
    (
      container.querySelector('button[aria-label="Back to the documents"]') as HTMLButtonElement
    ).click();
    await until(() => rows().length === 2);
    (container.querySelectorAll('main nav li button')[1] as HTMLButtonElement).click();
    await until(() => toggleOf() !== null);
    expect(toggleOf()?.getAttribute('aria-expanded')).toBe('false');
    expect(drawerHidden()).toBe(true);
  });

  it('Escape or choosing a document from the drawer puts focus back on its toggle', async () => {
    documents = [
      row({ title: 'A' }),
      row({ documentId: id(2), title: 'B', openedAt: '2026-11-17T00:00:00.000Z' }),
    ];
    await showDemo('fa');
    toggleOf()?.click();
    await until(() => !drawerHidden());
    const items = () => [
      ...container.querySelectorAll<HTMLButtonElement>('#mobile-document-list li button'),
    ];
    items()[0]?.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await until(() => drawerHidden());
    await until(() => document.activeElement === toggleOf());
    expect(document.activeElement).toBe(toggleOf());

    toggleOf()?.click();
    await until(() => !drawerHidden());
    items()[1]?.focus();
    items()[1]?.click();
    await until(() => container.querySelector('h1')?.textContent === 'B');
    await until(() => document.activeElement === toggleOf());
    expect(document.activeElement).toBe(toggleOf());

    // Escape with focus outside the drawer closes it but leaves focus where it was.
    toggleOf()?.click();
    await until(() => !drawerHidden());
    const back = container.querySelector(
      'button[aria-label="Back to the documents"]',
    ) as HTMLButtonElement;
    back.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await until(() => drawerHidden());
    await settle(30);
    expect(document.activeElement).toBe(back);
  });
});
