import type { DocumentSummary, SearchHit, ServerEvent } from '@vde-open/shared';
import { Menu, Monitor, Moon, Palette, Search, Sun, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import { RepositoryLabelsContext } from '@/components/document-location';
import { DocumentSwitcher } from '@/components/document-workspace';
import { DetailsPopover } from '@/components/details-popover';
import { SearchDialog } from '@/components/search-dialog';
import { Sidebar } from '@/components/sidebar';
import type { SectionTarget } from '@/components/viewer';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { createApi, type Api } from '@/lib/api';
import {
  documentInUrl,
  headingInUrl,
  writeDocumentToUrl,
  writeHeadingToUrl,
  type HeadingInUrl,
  type HeadingRestore,
  type HistoryMode,
} from '@/lib/location';
import {
  applyAppearance,
  colorPalettes,
  isColorPalette,
  isSidebarView,
  isTheme,
  usePreference,
  type ColorPalette,
  type SidebarView,
  type Theme,
} from '@/lib/preferences';
import { createRefresher } from '@/lib/refresher';
import { buildLabels } from '@/lib/repository-labels';

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 260;
// Shows the documents in the order the user set but has not been saved yet. Documents opened since then follow.
function arrange(documents: DocumentSummary[], order: string[] | null): DocumentSummary[] {
  if (order === null) return documents;
  const byId = new Map(documents.map((document) => [document.documentId, document]));
  const placed = order.flatMap((documentId) => byId.get(documentId) ?? []);
  const ordered = new Set(order);
  const rest = documents.filter((document) => !ordered.has(document.documentId));
  return [...placed, ...rest];
}

const isWidth = (value: unknown): value is number =>
  typeof value === 'number' && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX;

function useAppearance() {
  const [theme, setTheme] = usePreference<Theme>('theme', 'system', isTheme);
  const [palette, setPalette] = usePreference<ColorPalette>(
    'color-palette',
    'standard',
    isColorPalette,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyAppearance(theme, palette);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme, palette]);
  return { theme, setTheme, palette, setPalette };
}

export function Workspace({ api }: { api: Api }) {
  // The document list and the catalogVersion at the time it was fetched. Passed as the precondition when saving the order.
  const [catalog, setCatalog] = useState<{ documents: DocumentSummary[]; version: number }>({
    documents: [],
    version: 0,
  });
  // The document being shown. initialized is whether the first list has been fetched and a document chosen from it.
  // history is how the URL follows this change: push for a switch the user can go back from, replace otherwise.
  // requestedAt is the catalogVersion of the focus request that chose the document (0 otherwise). A focus request can
  // name a document opened just before it, so a list older than that version does not drop the choice.
  // restore is the heading in the URL to jump to again after a navigation through the URL (a reload, back or forward);
  // restores counts those requests and gives each its id.
  const [selection, setSelection] = useState<{
    activeId: string | null;
    initialized: boolean;
    history: HistoryMode;
    requestedAt: number;
    restore: HeadingRestore | null;
    restores: number;
  }>({
    activeId: null,
    initialized: false,
    history: 'replace',
    requestedAt: 0,
    restore: null,
    restores: 0,
  });
  // An order the user set that is still being saved. Lists fetched meanwhile (the notification of the first save
  // among them) keep showing it, so a further move builds on what is shown.
  const [unsavedOrder, setUnsavedOrder] = useState<string[] | null>(null);
  const documents = useMemo(
    () => arrange(catalog.documents, unsavedOrder),
    [catalog.documents, unsavedOrder],
  );
  const { activeId } = selection;
  // Switch to a document (list, search results, focus requests). Choosing the shown document again adds no history entry,
  // but a newer focus request still protects it (it can be the shown document closed and opened again).
  const selectDocument = useCallback((documentId: string, requestedAt = 0) => {
    setSelection((current) => {
      if (current.activeId !== documentId) {
        return { ...current, activeId: documentId, history: 'push', requestedAt, restore: null };
      }
      return requestedAt > current.requestedAt ? { ...current, requestedAt } : current;
    });
  }, []);
  // Keep the heading the shown document's view jumped to in the URL.
  const showHeading = useCallback(
    (heading: HeadingInUrl | null) => {
      if (activeId !== null) writeHeadingToUrl(activeId, heading);
    },
    [activeId],
  );
  const latestDocuments = useRef(documents);
  useEffect(() => {
    latestDocuments.current = documents;
  }, [documents]);
  // Keep the URL on the shown document. Until the first list arrives, the URL is not judged or rewritten.
  // The first write replaces the entry the UI was opened with.
  const urlWritten = useRef(false);
  useEffect(() => {
    if (!selection.initialized) return;
    writeDocumentToUrl(selection.activeId, urlWritten.current ? selection.history : 'replace');
    urlWritten.current = true;
  }, [selection]);
  // Back and forward: show the document in the URL if it is open, and jump to the heading the URL keeps (also within the
  // shown document). Otherwise stay and point the URL back at the shown document.
  useEffect(() => {
    const onPopState = () => {
      const fromUrl = documentInUrl();
      const heading = headingInUrl();
      setSelection((current) => {
        if (!current.initialized) return current;
        const open =
          fromUrl === current.activeId ||
          latestDocuments.current.some((document) => document.documentId === fromUrl);
        if (!open || fromUrl === null) return { ...current, history: 'replace' };
        const restores = current.restores + 1;
        return {
          ...current,
          activeId: fromUrl,
          history: 'replace',
          requestedAt: fromUrl === current.activeId ? current.requestedAt : 0,
          restore: heading === null ? null : { ...heading, id: restores },
          restores,
        };
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = usePreference<SidebarView>('sidebar-view', 'flat', isSidebarView);
  const [width, setWidth] = usePreference<number>('sidebar-width', SIDEBAR_DEFAULT, isWidth);
  const { theme, setTheme, palette, setPalette } = useAppearance();
  const lastEvent = useRef<{ daemonId: string; sequence: number } | null>(null);
  // How many question-change notifications have been received. The answer panel refetches the question each time this changes.
  const [feedbackSignal, setFeedbackSignal] = useState(0);
  // How many notifications that the view tried to load an unregistered file have been received.
  const [renderSignal, setRenderSignal] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  // Whether the document list (drawer) is open on screens narrower than 900px.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The section to jump to from a search result (kept with the revision that was searched).
  const [sectionTarget, setSectionTarget] = useState<
    (SectionTarget & { documentId: string }) | null
  >(null);

  // Cmd/Ctrl+K opens search. The combination types no character, so it may open while typing.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const openHit = (hit: SearchHit) => {
    selectDocument(hit.documentId);
    // The search result chosen now wins over a heading of the URL still waiting to be restored.
    setSelection((current) => (current.restore === null ? current : { ...current, restore: null }));
    setSectionTarget((current) => ({
      documentId: hit.documentId,
      sectionId: hit.sectionId,
      revision: hit.revision,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  };

  // Refetch the list from the daemon. Switch the shown document only if it was closed.
  const fetchList = useCallback(async () => {
    const [list, status] = await Promise.all([api.documents(), api.status()]);
    setCatalog({ documents: list.documents, version: list.catalogVersion });
    setSelection((current) => {
      const isOpen = (documentId: string | null): documentId is string =>
        documentId !== null &&
        list.documents.some((document) => document.documentId === documentId);
      const olderThanRequest = list.catalogVersion < current.requestedAt;
      if (isOpen(current.activeId) || (olderThanRequest && current.activeId !== null)) {
        return current.initialized
          ? current
          : { ...current, initialized: true, history: 'replace' };
      }
      // On first load, the document in the URL comes first (with the heading the URL keeps for it), then the one the
      // daemon remembers. Afterwards (the shown document was closed), the first in the list.
      const fromUrl = documentInUrl();
      const preferred = current.initialized
        ? null
        : ([fromUrl, status.activeDocumentId].find(isOpen) ?? null);
      const heading = preferred !== null && preferred === fromUrl ? headingInUrl() : null;
      const restores = current.restores + 1;
      return {
        ...current,
        activeId: preferred ?? list.documents[0]?.documentId ?? null,
        initialized: true,
        history: 'replace',
        requestedAt: 0,
        restore: heading === null ? null : { ...heading, id: restores },
        restores,
      };
    });
  }, [api]);
  // Fetch one at a time. Running in parallel lets an old list that arrives late overwrite a newer one.
  // Failures (such as while disconnected) are ignored; refetch on reconnect.
  const load = useMemo(() => createRefresher(fetchList), [fetchList]);

  // Changes of order are saved one at a time, each on the catalog version the previous one returned.
  // Moving a row twice quickly (Alt+Down twice) would otherwise send the second with a stale version and lose it.
  const reorders = useRef<{ chain: Promise<void>; pending: number; drained: number }>({
    chain: Promise.resolve(),
    pending: 0,
    drained: 0,
  });
  // Fetches the list. The order still being saved is dropped only when this fetch shows the saved state:
  // no save was pending when it started, none was added meanwhile, and it succeeded. Otherwise it stays shown,
  // and a later successful fetch drops it.
  const refetch = useCallback(async () => {
    const queue = reorders.current;
    const idle = queue.pending === 0;
    const drained = queue.drained;
    const succeeded = await load();
    if (succeeded && idle && queue.pending === 0 && queue.drained === drained) {
      setUnsavedOrder(null);
    }
  }, [load]);

  useEffect(() => {
    const onEvent = (event: ServerEvent) => {
      const previous = lastEvent.current;
      lastEvent.current = { daemonId: event.daemonId, sequence: event.sequence };
      if (event.type === 'daemon-stopping') {
        setNotice('The daemon has stopped. Run the CLI to open it again.');
        return;
      }
      // Switch the shown document only on an explicit focus request. The list is fetched again below.
      if (event.type === 'focus-requested' && event.documentId) {
        selectDocument(event.documentId, event.catalogVersion);
      }
      // Notifications can be missed. On any notification, refetch the list to match the current state.
      const gap =
        previous !== null &&
        (previous.daemonId !== event.daemonId || event.sequence > previous.sequence + 1);
      // Refetch the question on a change notification, and also when a notification may have been missed.
      if (event.type === 'feedback-changed' || event.type === 'resync-required' || gap) {
        setFeedbackSignal((value) => value + 1);
      }
      if (event.type === 'render-diagnostics') setRenderSignal((value) => value + 1);
      if (event.type !== 'hello' || gap) void refetch();
    };
    const stream = api.events({
      onEvent,
      // After reconnecting, refetch the list and the question to pick up changes made while disconnected.
      onConnect: () => {
        setNotice(null);
        setFeedbackSignal((value) => value + 1);
        void refetch();
      },
    });
    return () => stream.close();
  }, [api, refetch, selectDocument]);

  const active = useMemo(
    () => documents.find((document) => document.documentId === activeId) ?? null,
    [documents, activeId],
  );
  const labels = useMemo(() => buildLabels(documents), [documents]);

  const savedVersion = useRef(0);
  useEffect(() => {
    // Versions only grow; a list fetched before a save finished must not take the saved version back.
    savedVersion.current = Math.max(savedVersion.current, catalog.version);
  }, [catalog.version]);
  const reorder = (order: string[]) => {
    // Reorder the view first. If saving fails, the list fetched afterwards shows the saved order.
    setUnsavedOrder(order);
    const queue = reorders.current;
    queue.pending += 1;
    queue.chain = queue.chain.then(async () => {
      try {
        const saved = await api.reorder(order, savedVersion.current);
        // A list fetched meanwhile can already know a later version; never go back to an earlier one.
        savedVersion.current = Math.max(savedVersion.current, saved);
      } catch {
        // A conflict or a failure: the list fetched below shows the saved order.
      }
      queue.pending -= 1;
      if (queue.pending === 0) {
        queue.drained += 1;
        // The saved order is fetched first, then the unsaved one is dropped, so the list does not flicker.
        // Not awaited: whether to drop it is decided by refetch itself, and a stream of notifications that keeps
        // the fetches going must not hold back the next save.
        void refetch();
      }
    });
  };

  // Capture the pointer on the handle. Without it, moves over the document's iframe go to the iframe and the drag stops.
  // The capture is released on pointerup or pointercancel, which ends the drag.
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, event.clientX)));
  };

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      {/* On narrow screens, hide button labels and show only icons (the names stay for screen readers). */}
      <header className="flex min-w-0 items-center justify-between gap-2 border-b px-4 py-2 sm:gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="min-[900px]:hidden"
          aria-expanded={drawerOpen}
          aria-controls="document-list"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          {drawerOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          <span className="max-sm:sr-only">Document list</span>
        </Button>
        <p className="shrink-0 text-sm font-semibold">vde-open</p>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setSearchOpen(true)}
          aria-keyshortcuts="Meta+K Control+K"
        >
          <Search aria-hidden="true" />
          <span className="max-sm:sr-only">Search open documents</span>
          <kbd className="ml-1 text-xs text-muted-foreground max-sm:hidden">⌘K</kbd>
        </Button>
        <DetailsPopover
          title="Color palette"
          trigger={
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Color palette"
              title={`Color palette: ${colorPalettes.find((item) => item.value === palette)?.label}`}
            >
              <Palette aria-hidden="true" />
            </Button>
          }
        >
          <label htmlFor="color-palette" className="font-medium">
            Palette
          </label>
          <select
            id="color-palette"
            value={palette}
            onChange={(event) => {
              if (isColorPalette(event.target.value)) setPalette(event.target.value);
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {colorPalettes.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </DetailsPopover>
        <ToggleGroup
          value={[theme]}
          onValueChange={(value) => {
            const next: unknown = value[0];
            if (isTheme(next)) setTheme(next);
          }}
          size="sm"
          aria-label="Color scheme"
        >
          <ToggleGroupItem value="light" aria-label="Light">
            <Sun aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem value="dark" aria-label="Dark">
            <Moon aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem value="system" aria-label="Match OS setting">
            <Monitor aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>
      </header>
      {notice && (
        <p role="status" className="border-b bg-muted px-4 py-2 text-sm">
          {notice}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1">
        {/* Below 900px, the list becomes a drawer (do not cram three panes side by side; spec 13.2). */}
        <div
          id="document-list"
          className={`${drawerOpen ? 'block' : 'hidden'} absolute inset-y-0 left-0 z-20 w-72 max-w-[85vw] shrink-0 border-r bg-background shadow-lg min-[900px]:static min-[900px]:block min-[900px]:max-w-none min-[900px]:shadow-none`}
          style={{ width: drawerOpen ? undefined : width }}
        >
          <Sidebar
            documents={documents}
            labels={labels}
            activeId={activeId}
            view={view}
            onViewChange={setView}
            onSelect={(documentId) => {
              selectDocument(documentId);
              setDrawerOpen(false);
            }}
            onClose={(documentId) => void api.close(documentId).then(load, load)}
            onReorder={reorder}
          />
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize document list"
          className="hidden w-1 shrink-0 cursor-col-resize hover:bg-border min-[900px]:block"
          onPointerDown={startResize}
          onPointerMove={resize}
        />
        {active ? (
          <RepositoryLabelsContext value={labels}>
            <DocumentSwitcher
              documents={documents}
              api={api}
              document={active}
              feedbackSignal={feedbackSignal}
              renderSignal={renderSignal}
              sectionTarget={sectionTarget?.documentId === active.documentId ? sectionTarget : null}
              restoreHeading={selection.restore}
              onHeadingShown={showHeading}
            />
          </RepositoryLabelsContext>
        ) : (
          <main className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            Select a document from the list on the left to show it here.
          </main>
        )}
      </div>
      <SearchDialog api={api} open={searchOpen} onOpenChange={setSearchOpen} onSelect={openHit} />
    </div>
  );
}

export function App() {
  const [api] = useState(createApi);
  return <Workspace api={api} />;
}
