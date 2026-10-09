// @vitest-environment happy-dom
import type { DocumentSummary, FeedbackForUi, RenderGrantResult } from '@vde-open/shared';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Viewer, type ViewerProps } from '@/components/viewer';
import type { Api } from '@/lib/api';
import { documentAt } from '@/lib/document.fixture';

const REV1 = `rev_${'1'.repeat(64)}`;
const REV2 = `rev_${'2'.repeat(64)}`;
let container: HTMLElement;
let root: Root;
let api: Api;
let doc: DocumentSummary;

function grant(revision: string): RenderGrantResult {
  return {
    grant: revision,
    documentId: doc.documentId,
    revision,
    format: 'image',
    mode: 'static',
    documentUrl: `http://localhost/preview/${revision}/picture.png`,
    filesBaseUrl: `http://localhost/preview/${revision}/`,
    documentLogicalPath: 'picture.png',
    assets: [],
    links: [],
    diagnostics: [],
    headingTargets: [],
    bridge: null,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  doc = { ...documentAt('/picture.png', null, 'Picture'), format: 'image', revision: REV1 };
  api = {
    renderGrant: vi.fn<Api['renderGrant']>((_id: string, revision: string) =>
      Promise.resolve(grant(revision)),
    ),
    feedbackRenderGrant: vi.fn<Api['feedbackRenderGrant']>(() => Promise.resolve(grant(REV1))),
    releaseGrants: vi.fn<Api['releaseGrants']>(() => Promise.resolve()),
    refresh: vi.fn<Api['refresh']>(() => Promise.resolve()),
    content: vi.fn<Api['content']>(),
    outline: vi.fn<Api['outline']>(),
  } as unknown as Api;
});
afterEach(() => {
  root.unmount();
  container.remove();
});

function show(props: Partial<ViewerProps> = {}) {
  root.render(<Viewer api={api} document={doc} {...props} />);
}
function image() {
  return container.querySelector<HTMLImageElement>('img');
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Button "${label}" not found`);
  return found;
}

it('waits for image decoding before switching documents and never reads binary bytes as text', async () => {
  const onReady = vi.fn<() => void>();
  show({ onReady });
  await expect.poll(() => image()?.src).toContain(REV1);
  expect(onReady).not.toHaveBeenCalled();
  expect(api.content).not.toHaveBeenCalled();
  expect(api.outline).not.toHaveBeenCalled();
  expect(container.querySelector('iframe')).toBeNull();
  image()!.dispatchEvent(new Event('load'));
  await expect.poll(() => onReady.mock.calls.length).toBe(1);
  expect(container.textContent).not.toContain('Loading image');
});

it('shows a decoding error without leaving document switching stuck', async () => {
  const onReady = vi.fn<() => void>();
  show({ onReady });
  await expect.poll(() => image()?.src).toContain(REV1);
  image()!.dispatchEvent(new Event('error'));
  await expect
    .poll(() => container.querySelector('[role="alert"]')?.textContent)
    .toContain('This browser could not display the image');
  expect(image()!.hidden).toBe(true);
  expect(onReady).toHaveBeenCalledTimes(1);
  show({ document: { ...doc, revision: REV2 }, onReady });
  await expect.poll(() => image()?.src).toContain(REV2);
  expect(image()!.hidden).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('keeps the paused revision until resuming and exposes actual size and refresh controls', async () => {
  show();
  await expect.poll(() => image()?.src).toContain(REV1);
  button('Actual size').click();
  await expect.poll(() => button('Actual size').getAttribute('aria-pressed')).toBe('true');
  button('Pause updates').click();
  await expect.poll(() => container.textContent).toContain('Updates paused');
  show({ document: { ...doc, revision: REV2 } });
  await expect.poll(() => container.textContent).toContain('Update available');
  expect(image()!.src).toContain(REV1);
  expect(api.renderGrant).toHaveBeenCalledTimes(1);
  button('Resume updates').click();
  await expect.poll(() => image()?.src).toContain(REV2);
  await expect.poll(() => api.releaseGrants).toHaveBeenCalledWith([REV1]);
  button('Refresh').click();
  expect(api.refresh).toHaveBeenCalledWith(doc.documentId);
});

it('does not briefly show the current image while a pending question revision is being fetched', async () => {
  const onReady = vi.fn<() => void>();
  show({ waitingForRequest: true, onReady });
  await expect.poll(() => container.textContent).toContain('Loading image');
  expect(image()).toBeNull();
  expect(api.renderGrant).not.toHaveBeenCalled();
  expect(onReady).not.toHaveBeenCalled();
  show({
    document: { ...doc, revision: REV2 },
    fixedRevision: REV1,
    request: { requestId: 'req_question', status: 'pending' } as FeedbackForUi,
    onReady,
  });
  await expect.poll(() => image()?.src).toContain(REV1);
  expect(api.feedbackRenderGrant).toHaveBeenCalledWith('req_question');
  expect(api.renderGrant).not.toHaveBeenCalled();
  expect(button('Pause updates').disabled).toBe(true);
});
