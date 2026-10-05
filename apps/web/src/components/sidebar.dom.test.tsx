// @vitest-environment happy-dom
import type { DocumentSummary } from '@vde-open/shared';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { documentAt, inRepository, inWorktree } from '@/lib/document.fixture';
import type { SidebarView } from '@/lib/preferences';

import { buildLabels } from '@/lib/repository-labels';

import { DocumentLocation, RepositoryLabelsContext } from './document-location.tsx';
import { Sidebar } from './sidebar.tsx';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
});

function show(documents: DocumentSummary[], view: SidebarView = 'flat') {
  flushSync(() => {
    root.render(
      <Sidebar
        documents={documents}
        activeId={null}
        view={view}
        onViewChange={() => undefined}
        onSelect={() => undefined}
        onClose={() => undefined}
        onReorder={() => undefined}
      />,
    );
  });
}

// The text a screen reader takes as the name: everything inside except what is aria-hidden or display: none.
function nameOf(element: Element): string {
  let text = '';
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
    else if (node instanceof Element && node.getAttribute('aria-hidden') !== 'true') {
      text += nameOf(node);
    }
  }
  return text;
}

const rows = () => [...container.querySelectorAll<HTMLButtonElement>('button[data-document-id]')];
const descriptionOf = (row: Element) =>
  document.getElementById(row.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
const part = (row: Element, name: string) =>
  row.querySelector(`[data-part="${name}"]`)?.textContent ?? '';

describe('flat rows', () => {
  it('keep the title as the name, and describe the location and the format', () => {
    const document = inWorktree('/r/app', '/r/app/.git/wt/feature/x', 'docs/plan.md', {
      name: 'x',
      branch: 'feature/x',
    });
    show([{ ...document, title: 'Plan', format: 'html' }]);
    const [row] = rows();

    expect(nameOf(row as Element)).toBe('Plan');
    expect(descriptionOf(row as Element)).toBe('app · worktree feature/x (x) · docs/plan.md. HTML');
    expect(part(row as Element, 'repository')).toBe('app');
    expect(part(row as Element, 'worktree')).toBe('feature/x');
    expect(part(row as Element, 'location')).toContain('docs/plan.md');
    expect(part(row as Element, 'location-full')).toBe(
      'app · worktree feature/x (x) · docs/plan.md',
    );
  });

  it('keep the badges in the name', () => {
    show([
      {
        ...inRepository('/r/app', 'a.md'),
        title: 'A',
        sourceState: 'missing',
        pendingRequestIds: ['req_1'],
      },
    ]);
    expect(nameOf(rows()[0] as Element)).toBe('AFile missingQuestion');
    expect(container.querySelector('[data-testid="pending-question"]')?.textContent).toBe(
      'Question',
    );
  });

  it('color the icon by format', () => {
    show([
      { ...inRepository('/r/app', 'a.md'), format: 'markdown' },
      { ...inRepository('/r/app', 'b.html'), format: 'html' },
    ]);
    const icons = rows().map((row) => row.querySelector('svg[data-format]'));
    expect(icons.map((icon) => icon?.getAttribute('data-format'))).toEqual(['markdown', 'html']);
    expect(icons[0]?.getAttribute('class')).toContain('text-format-markdown');
    expect(icons[1]?.getAttribute('class')).toContain('text-format-html');
  });

  it('tell same-named repositories and same-titled documents apart', () => {
    show([
      { ...inRepository('/a/me/dotfiles', 'a/docs/README.md'), title: 'README' },
      { ...inRepository('/a/you/dotfiles', 'a/docs/README.md'), title: 'README' },
      { ...inRepository('/a/me/dotfiles', 'b/docs/README.md'), title: 'README' },
    ]);
    expect(rows().map((row) => part(row, 'repository'))).toEqual([
      'me/dotfiles',
      'you/dotfiles',
      'me/dotfiles',
    ]);
    expect(rows().map((row) => part(row, 'location'))).toEqual([
      'me/dotfilesa/docs/README.md',
      'you/dotfiles…/docs/README.md',
      'me/dotfilesb/docs/README.md',
    ]);
  });

  it('show stdin with its format, and a file outside a repository by its own path', () => {
    show([{ ...documentAt(null), format: 'html' }, documentAt('/home/u/notes/plan.md')]);
    expect(rows().map((row) => part(row, 'location'))).toEqual([
      'Standard input · HTML',
      '…/notes/plan.md',
    ]);
  });

  it('change when the list arrives again with another branch', () => {
    const before = inWorktree('/r/app', '/w/x', 'a.md', { name: 'x', branch: 'one' });
    show([before]);
    expect(part(rows()[0] as Element, 'worktree')).toBe('one');

    const after = inWorktree('/r/app', '/w/x', 'a.md', { name: 'x', branch: 'two' });
    show([{ ...after, documentId: before.documentId }]);
    expect(part(rows()[0] as Element, 'worktree')).toBe('two');
  });

  it('describe why the repository could not be identified', () => {
    show([
      documentAt('/r/copy/a.md', {
        state: 'unresolved',
        id: '/r/copy',
        nameSegments: ['r', 'copy'],
        pathInCheckout: ['a.md'],
        reason: 'link-mismatch',
      }),
    ]);
    expect(descriptionOf(rows()[0] as Element)).toContain(
      "This folder's .git does not match its repository",
    );
  });
});

describe('tree rows', () => {
  it('keep the name of a worktree shown on its repository row', () => {
    show(
      [inWorktree('/r/app', '/w/x', 'docs/plan.md', { name: 'x', branch: 'feature/x' })],
      'tree',
    );
    const worktree = container.querySelector('[data-node="worktree"]');
    const repository = container.querySelector('[data-node="repository"]');

    expect(worktree?.getAttribute('aria-label')).toBe('Worktree feature/x');
    expect(worktree?.querySelector('div')?.className).toBe('sr-only');
    expect(repository?.getAttribute('aria-label')).toBe('app, worktree feature/x');
    expect(rows().map((row) => nameOf(row))).toEqual(['plan.md']);
  });
});

describe('focus across list updates', () => {
  it('stays on a row that moves from the pending group into its repository', () => {
    const pending = documentAt('/r/app/a.md', { state: 'pending' });
    show([pending, inRepository('/r/app', 'b.md')], 'tree');
    const before = rows().find((row) => row.dataset['documentId'] === pending.documentId);
    before?.focus();
    expect(document.activeElement).toBe(before);

    const resolved = { ...inRepository('/r/app', 'a.md'), documentId: pending.documentId };
    show([resolved, inRepository('/r/app', 'b.md')], 'tree');
    const after = rows().find((row) => row.dataset['documentId'] === pending.documentId);

    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
  });

  it('does not take focus back to a document that was closed and opened again', () => {
    const first = inRepository('/r/app', 'a.md');
    const second = inRepository('/r/app', 'b.md');
    show([first, second]);
    rows()[1]?.focus();
    // Closed with its own remove button: the row goes away, focus falls to the body.
    show([first]);
    expect(document.activeElement).toBe(document.body);
    show([first, second]);
    expect(document.activeElement).toBe(document.body);
  });

  it('does not take focus back after it left the list', async () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    const first = inRepository('/r/app', 'a.md');
    show([first]);
    rows()[0]?.focus();
    outside.focus();
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));

    show([{ ...first, title: 'renamed' }]);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe('the viewer header location', () => {
  const location = (document: DocumentSummary) => {
    flushSync(() => {
      root.render(<DocumentLocation document={document} />);
    });
    return container.textContent;
  };

  it('shows the repository, the worktree with its name, and the path', () => {
    expect(
      location(inWorktree('/r/app', '/w/x', 'docs/plan.md', { name: 'x', branch: 'feature/x' })),
    ).toBe('app worktree feature/x (x) · docs/plan.md');
    expect(location(inRepository('/r/app', 'docs/a.md'))).toBe('app · docs/a.md');
  });

  it('names a repository the way the list does', () => {
    const documents = [inRepository('/a/me/app', 'x.md'), inRepository('/a/you/app', 'y.md')];
    flushSync(() => {
      root.render(
        <RepositoryLabelsContext value={buildLabels(documents)}>
          <DocumentLocation document={documents[1] as DocumentSummary} />
        </RepositoryLabelsContext>,
      );
    });
    expect(container.textContent).toBe('you/app · y.md');
  });

  it('shows the canonical path outside a repository and while checking', () => {
    expect(location(documentAt('/home/u/notes/a.md'))).toBe('/home/u/notes/a.md');
    expect(location(documentAt('/mnt/slow/b.md', { state: 'pending' }))).toBe(
      'Checking repository… · /mnt/slow/b.md',
    );
  });
});
