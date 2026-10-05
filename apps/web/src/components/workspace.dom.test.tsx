// @vitest-environment happy-dom
import type {
  DocumentSummary,
  FeedbackForUi,
  OutlineItem,
  Questionnaire,
  RenderGrantResult,
  SearchHit,
  SearchResult,
  ServerEvent,
} from '@vde-open/shared';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '@/App';
import type { Api } from '@/lib/api';
import { writeHeadingToUrl, type HeadingInUrl } from '@/lib/location';

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
    canonicalPath: '/a.html',
    repository: null,
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

describe('jumping from the outline of an HTML document', () => {
  const outline: OutlineItem[] = [
    { sectionId: 'sec_0001', level: 1, title: '概要', headingPath: ['概要'], anchor: 'h1' },
    {
      sectionId: 'sec_0002',
      level: 2,
      title: '削除',
      headingPath: ['概要', '削除'],
      anchor: 'same',
    },
    {
      sectionId: 'sec_0003',
      level: 2,
      title: '詳細',
      headingPath: ['概要', '詳細'],
      anchor: 'same',
    },
  ];
  function grantOf(overrides: Partial<RenderGrantResult> = {}): RenderGrantResult {
    return {
      grant: 'g1',
      documentId: 'doc_1',
      revision: REV1,
      format: 'html',
      mode: 'static',
      documentUrl: 'about:blank',
      filesBaseUrl: 'about:blank',
      documentLogicalPath: 'a.html',
      assets: [],
      links: [],
      diagnostics: [],
      // The second heading shares its anchor with the third and is removed from the view.
      headingTargets: [
        { sectionId: 'sec_0001', anchor: 'h1' },
        { sectionId: 'sec_0003', anchor: 'same' },
      ],
      bridge: null,
      ...overrides,
    };
  }
  const findItem = (title: string): HTMLButtonElement | null => {
    const found = [...container.querySelectorAll('aside[aria-label="Outline"] button')].find(
      (candidate) => candidate.textContent === title,
    );
    return found instanceof HTMLButtonElement ? found : null;
  };
  const item = (title: string): HTMLButtonElement => {
    const found = findItem(title);
    if (found === null) throw new Error(`Outline item "${title}" not found`);
    return found;
  };
  // For waiting: the outline can arrive after the view, so a missing item is not an error yet.
  const enabled = (title: string) => findItem(title)?.disabled === false;
  // Record where the view is moved to. The view is on another origin, so only its location is set.
  function recordJumps(): string[] {
    const jumps: string[] = [];
    const frame = container.querySelector('iframe') as HTMLIFrameElement;
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { location: { replace: (url: string) => jumps.push(url) } },
    });
    return jumps;
  }

  beforeEach(() => {
    window.localStorage.setItem('vde-open.pref.view-mode', JSON.stringify('preview'));
    api.outline = () => Promise.resolve(outline);
    api.renderMissing = () => Promise.resolve([]);
  });

  it('jumps only to headings the static view has, matched by sectionId', async () => {
    api.renderGrant = () => Promise.resolve(grantOf());
    root.render(<Viewer api={api} document={documentOf()} />);
    await until(() => container.querySelector('iframe') !== null && enabled('概要'));
    expect(item('概要').disabled).toBe(false);
    // Its anchor is reachable, but it names another heading: the second one is not in the view.
    expect(item('削除').disabled).toBe(true);
    expect(item('削除').title).toContain('not in the view');
    expect(item('詳細').disabled).toBe(false);

    const jumps = recordJumps();
    item('詳細').click();
    item('概要').click();
    expect(jumps).toEqual(['about:blank#same', 'about:blank#h1']);
  });

  it('does not jump while the view shows a newer revision than the outline, including when the body fails to load', async () => {
    let failNext = false;
    api.renderGrant = (_documentId, revision) =>
      Promise.resolve(grantOf({ grant: `g-${revision}`, revision }));
    api.content = (_documentId, revision) => {
      contentRequests.push(revision);
      if (revision === REV1) return Promise.resolve('本文 1');
      return failNext
        ? Promise.reject(new Error('Could not be read.'))
        : new Promise<string>(() => undefined);
    };
    root.render(<Viewer api={api} document={documentOf()} />);
    await until(() => container.querySelector('iframe') !== null && enabled('概要'));

    // The view of the new revision is ready before its body and outline.
    root.render(<Viewer api={api} document={documentOf({ revision: REV2 })} />);
    // The view leaves the screen until the grant of the new revision arrives, so wait for it to be back.
    await until(
      () =>
        contentRequests.includes(REV2) &&
        container.querySelector('iframe') !== null &&
        findItem('概要')?.disabled === true,
    );
    expect(item('概要').disabled).toBe(true);
    expect(item('概要').title).toBe('Available once the outline of the shown revision has loaded');

    // The body of the new revision cannot be loaded: the previous outline stays, and still cannot be used for the new view.
    failNext = true;
    root.unmount();
    root = createRoot(container);
    contentRequests = [];
    root.render(<Viewer api={api} document={documentOf()} />);
    await until(() => container.querySelector('iframe') !== null && enabled('概要'));
    root.render(<Viewer api={api} document={documentOf({ revision: REV2 })} />);
    await until(
      () =>
        (container.textContent?.includes('Could not be read.') ?? false) &&
        container.querySelector('iframe') !== null,
    );
    expect(item('概要').disabled).toBe(true);
    expect(item('概要').title).toBe('Available once the outline of the shown revision has loaded');
    expect(item('詳細').disabled).toBe(true);
  });

  it('does not jump in the Interactive view', async () => {
    api.renderGrant = () => Promise.resolve(grantOf({ mode: 'interactive', headingTargets: [] }));
    root.render(
      <Viewer
        api={api}
        document={documentOf({ htmlMode: 'interactive', interactiveAllowed: true })}
      />,
    );
    await until(() => container.querySelector('iframe') !== null && findItem('概要') !== null);
    await settle();
    expect(item('概要').disabled).toBe(true);
    expect(item('概要').title).toContain('Not available in the Interactive view');
  });

  describe('the heading kept in the URL', () => {
    // Record every jump, including the one made right as the view appears.
    let jumps: string[];
    const original = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    const second = documentOf({
      documentId: 'doc_2',
      title: '二つ目',
      displayPath: 'b.html',
      pathSegments: ['b.html'],
      order: 1,
    });
    const params = () => new URLSearchParams(window.location.search);

    beforeEach(() => {
      jumps = [];
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        configurable: true,
        get: () => ({ location: { replace: (url: string) => jumps.push(url) } }),
      });
      api.renderGrant = () => Promise.resolve(grantOf());
    });

    afterEach(() => {
      if (original) Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', original);
      window.history.replaceState(null, '', '/');
    });

    it('jumps to it once the view can jump, by the same section and title, else by the title, and reports where it went', async () => {
      api.renderGrant = (_documentId, revision) =>
        Promise.resolve(grantOf({ grant: `g-${revision}`, revision }));
      const shown: Array<HeadingInUrl | null> = [];
      const view = (revision: string) => (
        <Viewer
          api={api}
          document={documentOf({ revision })}
          // A heading was added above it, so the section number no longer matches the title.
          restoreHeading={{ sectionId: 'sec_0001', title: '詳細', id: 1 }}
          onHeadingShown={(heading) => shown.push(heading)}
        />
      );
      root.render(view(REV1));
      await until(() => shown.length > 0);
      expect(jumps).toEqual(['about:blank#same']);
      expect(shown).toEqual([{ sectionId: 'sec_0003', title: '詳細' }]);

      // Only once per view, even when a new revision is shown.
      root.render(view(REV2));
      await until(() => contentRequests.includes(REV2));
      await settle(100);
      expect(jumps).toHaveLength(1);
      expect(shown).toHaveLength(1);

      item('概要').click();
      expect(jumps).toEqual(['about:blank#same', 'about:blank#h1']);
      expect(shown.at(-1)).toEqual({ sectionId: 'sec_0001', title: '概要' });

      // A new request (back or forward within the document) is handled by the same view.
      root.render(
        <Viewer
          api={api}
          document={documentOf({ revision: REV2 })}
          restoreHeading={{ sectionId: 'sec_0003', title: '詳細', id: 2 }}
          onHeadingShown={(heading) => shown.push(heading)}
        />,
      );
      await until(() => jumps.length === 3);
      expect(jumps).toHaveLength(3);
      expect(jumps.at(-1)).toBe('about:blank#same');
    });

    it('drops a heading that is gone, or that the view cannot reach, without jumping', async () => {
      for (const heading of [
        { sectionId: 'sec_0003', title: '無い見出し', id: 1 },
        { sectionId: 'sec_0002', title: '削除', id: 1 },
      ]) {
        root.unmount();
        root = createRoot(container);
        const shown: Array<HeadingInUrl | null> = [];
        root.render(
          <Viewer
            api={api}
            document={documentOf()}
            restoreHeading={heading}
            onHeadingShown={(next) => shown.push(next)}
          />,
        );
        await until(() => shown.length > 0);
        expect(shown).toEqual([null]);
      }
      expect(jumps).toEqual([]);
    });

    it('waits while the view cannot jump (the Interactive view)', async () => {
      api.renderGrant = () => Promise.resolve(grantOf({ mode: 'interactive', headingTargets: [] }));
      const shown: Array<HeadingInUrl | null> = [];
      root.render(
        <Viewer
          api={api}
          document={documentOf({ htmlMode: 'interactive', interactiveAllowed: true })}
          restoreHeading={{ sectionId: 'sec_0003', title: '詳細', id: 1 }}
          onHeadingShown={(heading) => shown.push(heading)}
        />,
      );
      await until(() => container.querySelector('iframe') !== null && findItem('詳細') !== null);
      await settle(100);
      expect(shown).toEqual([]);
      expect(jumps).toEqual([]);
    });

    async function start(url: string): Promise<void> {
      window.history.replaceState(null, '', url);
      root.render(<Workspace api={api} />);
      await settle();
      handlers?.onConnect();
      await until(() => container.querySelector('iframe') !== null);
    }

    it('keeps the heading jumped to without adding history, drops it on a switch, and jumps to it again on back', async () => {
      current.documents = [documentOf(), second];
      await start('/');
      await until(() => params().get('document') === 'doc_1' && enabled('詳細'));
      const length = window.history.length;
      item('詳細').click();
      expect(params().get('section')).toBe('sec_0003');
      expect(params().get('heading')).toBe('詳細');
      expect(window.history.length).toBe(length);

      const listItem = container.querySelector('#document-list button[data-document-id="doc_2"]');
      (listItem as HTMLButtonElement).click();
      await until(() => params().get('document') === 'doc_2');
      expect(window.location.search).toBe('?document=doc_2');
      expect(window.history.length).toBe(length + 1);

      // Back to the entry of the first document, which still has its heading.
      window.history.replaceState(null, '', '/?document=doc_1&section=sec_0003&heading=詳細');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await until(() => jumps.length === 2);
      expect(jumps).toEqual(['about:blank#same', 'about:blank#same']);
    });

    it('on first load jumps to the heading in the URL; the heading of a document no longer open is dropped', async () => {
      await start('/?document=doc_1&section=sec_0003&heading=詳細');
      await until(() => jumps.length === 1);
      expect(jumps).toEqual(['about:blank#same']);
      expect(params().get('heading')).toBe('詳細');

      root.unmount();
      root = createRoot(container);
      await start('/?document=doc_9&section=sec_0003&heading=詳細');
      await until(() => params().get('document') === 'doc_1');
      await settle(100);
      expect(window.location.search).toBe('?document=doc_1');
      expect(jumps).toHaveLength(1);
    });

    it('back within the shown document jumps to the heading its entry keeps, for every such entry', async () => {
      current.documents = [documentOf(), second];
      await start('/');
      await until(() => params().get('document') === 'doc_1' && enabled('詳細'));
      item('詳細').click();
      // The other document is shown, then closed, so the view returns to the first document without its heading.
      (
        container.querySelector(
          '#document-list button[data-document-id="doc_2"]',
        ) as HTMLButtonElement
      ).click();
      await until(() => params().get('document') === 'doc_2');
      current.documents = [documentOf()];
      handlers?.onEvent({
        type: 'catalog-changed',
        daemonId: 'd1',
        sequence: 1,
        catalogVersion: 2,
      });
      await until(() => window.location.search === '?document=doc_1');
      await until(() => enabled('詳細'));
      expect(jumps).toEqual(['about:blank#same']);

      for (const expected of [2, 3]) {
        window.history.replaceState(null, '', '/?document=doc_1&section=sec_0003&heading=詳細');
        window.dispatchEvent(new PopStateEvent('popstate'));
        await until(() => jumps.length === expected);
        expect(jumps).toHaveLength(expected);
        expect(jumps.at(-1)).toBe('about:blank#same');
      }
    });

    it('a search result chosen while a heading of the URL waits to be restored cancels that restore', async () => {
      let showView: () => void = () => undefined;
      api.renderGrant = () =>
        new Promise<RenderGrantResult>((resolve) => {
          showView = () => resolve(grantOf());
        });
      const searches: Array<() => void> = [];
      const hit: SearchHit = {
        documentId: 'doc_1',
        revision: REV1,
        title: '文書',
        displayPath: 'a.html',
        sectionId: 'sec_0001',
        headingPath: ['概要'],
        excerpt: '概要',
        matchKind: 'text',
        score: 1,
        sourceRange: null,
        extraction: 'static-html',
      };
      api.search = () =>
        new Promise((resolve) =>
          searches.push(() => resolve({ hits: [hit] } as unknown as SearchResult)),
        );
      window.history.replaceState(null, '', '/?document=doc_1&section=sec_0003&heading=詳細');
      root.render(<Workspace api={api} />);
      await settle();
      handlers?.onConnect();
      await until(() => container.querySelector('aside[aria-label="Outline"]') !== null);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
      await until(() => document.querySelector('input[aria-label="Search query"]') !== null);
      const query = document.querySelector('input[aria-label="Search query"]') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        query,
        '概要',
      );
      query.dispatchEvent(new Event('input', { bubbles: true }));
      await until(() => searches.length > 0);
      searches.shift()?.();
      await until(() => document.querySelectorAll('[role="option"]').length === 1);
      query.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await until(() => document.querySelector('input[aria-label="Search query"]') === null);

      // The view becomes ready only now. The heading of the URL is not jumped to any more.
      showView();
      await until(() => container.querySelector('iframe') !== null && enabled('詳細'));
      await settle(100);
      expect(jumps).toEqual([]);
    });

    it('a view being left never writes its heading into the next document of the URL', () => {
      window.history.replaceState(null, '', '/?document=doc_2');
      writeHeadingToUrl('doc_1', { sectionId: 'sec_0001', title: '概要' });
      expect(window.location.search).toBe('?document=doc_2');
      writeHeadingToUrl('doc_2', { sectionId: 'sec_0001', title: '概要' });
      expect(params().get('section')).toBe('sec_0001');
      writeHeadingToUrl('doc_2', null);
      expect(window.location.search).toBe('?document=doc_2');
    });
  });
});

describe('keeping the shown document in the URL', () => {
  const second = documentOf({
    documentId: 'doc_2',
    title: '二つ目',
    displayPath: 'b.html',
    pathSegments: ['b.html'],
    order: 1,
  });
  const shownTitle = () =>
    container.querySelector('section[aria-label="Document view"] h1')?.textContent ?? '';
  // A row of the list, found by its document (its tooltip holds the whole location, not only the path).
  const listItem = (documentId: string) => {
    const found = container.querySelector(
      `#document-list button[data-document-id="${documentId}"]`,
    );
    if (!(found instanceof HTMLButtonElement))
      throw new Error(`List item "${documentId}" not found`);
    return found;
  };
  let sequence = 0;
  const notify = (event: Partial<ServerEvent>) => {
    sequence += 1;
    handlers?.onEvent({
      type: 'document-status',
      daemonId: 'd1',
      sequence,
      catalogVersion: 1,
      ...event,
    });
  };
  async function start(url: string): Promise<void> {
    window.history.replaceState(null, '', url);
    root.render(<Workspace api={api} />);
    await settle();
    // The list is fetched once the notification stream connects.
    handlers?.onConnect();
    await until(() => shownTitle() !== '');
  }

  beforeEach(() => {
    current.documents = [documentOf(), second];
    sequence = 0;
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('on first load, shows the document in the URL if it is open, otherwise the one the daemon remembers, without adding history', async () => {
    const length = window.history.length;
    await start('/?document=doc_2');
    expect(shownTitle()).toBe('二つ目');
    expect(window.location.search).toBe('?document=doc_2');

    for (const url of ['/?document=doc_9', '/']) {
      root.unmount();
      root = createRoot(container);
      await start(url);
      expect(shownTitle()).toBe('文書');
      await until(() => window.location.search === '?document=doc_1');
      expect(window.location.search).toBe('?document=doc_1');
    }
    expect(window.history.length).toBe(length);
  });

  it('keeps the query when the bootstrap fragment is removed', async () => {
    const { establishSession } = await import('@/lib/api');
    window.history.replaceState(null, '', '/?document=doc_2#bootstrap=used');
    const fetchMock = () => Promise.reject(new Error('offline'));
    const original = window.fetch;
    window.fetch = fetchMock as typeof window.fetch;
    try {
      await establishSession();
    } finally {
      window.fetch = original;
    }
    expect(window.location.search).toBe('?document=doc_2');
    expect(window.location.hash).toBe('');
  });

  it('a switch from the list or a focus request adds a history entry; choosing the shown document again does not', async () => {
    await start('/');
    await until(() => window.location.search === '?document=doc_1');
    const length = window.history.length;
    listItem('doc_2').click();
    await until(() => shownTitle() === '二つ目');
    expect(window.location.search).toBe('?document=doc_2');
    expect(window.history.length).toBe(length + 1);

    listItem('doc_2').click();
    notify({ type: 'focus-requested', documentId: 'doc_2' });
    await settle();
    expect(window.history.length).toBe(length + 1);

    notify({ type: 'focus-requested', documentId: 'doc_1' });
    await until(() => shownTitle() === '文書');
    expect(window.location.search).toBe('?document=doc_1');
    expect(window.history.length).toBe(length + 2);
  });

  it('back and forward show the document in the URL; for a document no longer open, the shown one stays and the URL is fixed', async () => {
    await start('/?document=doc_2');
    const length = window.history.length;
    window.history.replaceState(null, '', '/?document=doc_1');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await until(() => shownTitle() === '文書');
    expect(shownTitle()).toBe('文書');

    for (const url of ['/?document=doc_9', '/']) {
      window.history.replaceState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
      await until(() => window.location.search === '?document=doc_1');
      expect(shownTitle()).toBe('文書');
      expect(window.location.search).toBe('?document=doc_1');
    }
    expect(window.history.length).toBe(length);
  });

  it('when the shown document is closed, shows the first one and replaces the URL; an empty list removes the document from it', async () => {
    await start('/?document=doc_2');
    const length = window.history.length;
    current.documents = [documentOf()];
    notify({});
    await until(() => shownTitle() === '文書');
    expect(window.location.search).toBe('?document=doc_1');

    current.documents = [];
    notify({});
    await until(() => window.location.search === '');
    expect(window.location.search).toBe('');
    expect(shownTitle()).toBe('');
    expect(window.history.length).toBe(length);
  });

  it('a list fetched before a focus request does not drop the focused document, which the next list confirms or drops', async () => {
    // Each fetch returns the list as it was when the fetch started. While holding, replies wait to be released.
    let holding = false;
    let catalogVersion = 1;
    const held: Array<() => void> = [];
    api.documents = () => {
      const reply = { documents: current.documents, catalogVersion, cursor: null };
      if (!holding) return Promise.resolve(reply);
      return new Promise((resolve) => held.push(() => resolve(reply)));
    };
    current.documents = [documentOf()];
    await start('/');
    await until(() => window.location.search === '?document=doc_1');
    const length = window.history.length;

    // A fetch starts before the second document is opened and focused from the CLI.
    holding = true;
    notify({});
    await until(() => held.length === 1);
    holding = false;
    current.documents = [documentOf(), second];
    catalogVersion = 2;
    notify({ type: 'focus-requested', documentId: 'doc_2', catalogVersion });
    await until(() => window.location.search === '?document=doc_2');
    held.shift()?.();
    await until(() => shownTitle() === '二つ目');
    await settle(100);
    expect(shownTitle()).toBe('二つ目');
    expect(window.location.search).toBe('?document=doc_2');
    expect(window.history.length).toBe(length + 1);

    // A focused document that the next list does not have is dropped.
    holding = true;
    notify({});
    await until(() => held.length === 1);
    holding = false;
    notify({ type: 'focus-requested', documentId: 'doc_9', catalogVersion });
    held.shift()?.();
    await until(() => window.location.search === '?document=doc_1');
    expect(shownTitle()).toBe('文書');
  });

  it('a focus request for the shown document, closed and opened again, is not undone by a list fetched in between', async () => {
    let holding = false;
    let catalogVersion = 1;
    const held: Array<() => void> = [];
    api.documents = () => {
      const reply = { documents: current.documents, catalogVersion, cursor: null };
      if (!holding) return Promise.resolve(reply);
      return new Promise((resolve) => held.push(() => resolve(reply)));
    };
    await start('/?document=doc_2');
    expect(shownTitle()).toBe('二つ目');
    const length = window.history.length;

    // The shown document is closed; the list fetched for that is held.
    current.documents = [documentOf()];
    catalogVersion = 2;
    holding = true;
    notify({ catalogVersion });
    await until(() => held.length === 1);
    holding = false;
    // It is opened again with the same ID and focused before that list arrives.
    current.documents = [documentOf(), second];
    catalogVersion = 3;
    notify({ type: 'focus-requested', documentId: 'doc_2', catalogVersion });
    held.shift()?.();
    await settle(100);
    expect(shownTitle()).toBe('二つ目');
    expect(window.location.search).toBe('?document=doc_2');
    expect(window.history.length).toBe(length);
  });

  it('does not judge or rewrite the URL before the first list arrives', async () => {
    api.documents = () => new Promise(() => undefined);
    window.history.replaceState(null, '', '/?document=doc_9');
    root.render(<Workspace api={api} />);
    await settle();
    handlers?.onConnect();
    await settle(100);
    expect(window.location.search).toBe('?document=doc_9');
  });
});
