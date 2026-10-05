import type { DocumentSummary, SearchHit, ServerEvent } from '@vde-open/shared';
import { Menu, Monitor, Moon, Search, Sun, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import { DocumentWorkspace } from '@/components/document-workspace';
import { SearchDialog } from '@/components/search-dialog';
import { Sidebar } from '@/components/sidebar';
import type { SectionTarget } from '@/components/viewer';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { createApi, establishSession, forgetSession, type Api } from '@/lib/api';
import {
  isSidebarView,
  isTheme,
  usePreference,
  type SidebarView,
  type Theme,
} from '@/lib/preferences';
import { createRefresher } from '@/lib/refresher';

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 260;
const isWidth = (value: unknown): value is number =>
  typeof value === 'number' && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX;

function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = usePreference<Theme>('theme', 'system', isTheme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      window.document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}

export function Workspace({ api }: { api: Api }) {
  // The document list and the catalogVersion at the time it was fetched. Passed as the precondition when saving the order.
  const [catalog, setCatalog] = useState<{ documents: DocumentSummary[]; version: number }>({
    documents: [],
    version: 0,
  });
  // The document being shown. initialized is whether the document the daemon remembers has been selected on first load.
  const [selection, setSelection] = useState<{ activeId: string | null; initialized: boolean }>({
    activeId: null,
    initialized: false,
  });
  const { documents } = catalog;
  const { activeId } = selection;
  const setActiveId = useCallback((documentId: string) => {
    setSelection((current) => ({ ...current, activeId: documentId }));
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = usePreference<SidebarView>('sidebar-view', 'flat', isSidebarView);
  const [width, setWidth] = usePreference<number>('sidebar-width', SIDEBAR_DEFAULT, isWidth);
  const [theme, setTheme] = useTheme();
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
    setActiveId(hit.documentId);
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
      const stillOpen =
        current.activeId !== null &&
        list.documents.some((document) => document.documentId === current.activeId);
      if (stillOpen) return current.initialized ? current : { ...current, initialized: true };
      // Only on first load, select the document the daemon remembers.
      const preferred = current.initialized ? null : status.activeDocumentId;
      return {
        activeId: preferred ?? list.documents[0]?.documentId ?? null,
        initialized: true,
      };
    });
  }, [api]);
  // Fetch one at a time. Running in parallel lets an old list that arrives late overwrite a newer one.
  // Failures (such as while disconnected) are ignored; refetch on reconnect.
  const load = useMemo(() => createRefresher(fetchList), [fetchList]);

  useEffect(() => {
    const onEvent = (event: ServerEvent) => {
      const previous = lastEvent.current;
      lastEvent.current = { daemonId: event.daemonId, sequence: event.sequence };
      if (event.type === 'daemon-stopping') {
        setNotice('The daemon has stopped. Run the CLI to open it again.');
        return;
      }
      // Switch the shown document only on an explicit focus request.
      if (event.type === 'focus-requested' && event.documentId) setActiveId(event.documentId);
      // Notifications can be missed. On any notification, refetch the list to match the current state.
      const gap =
        previous !== null &&
        (previous.daemonId !== event.daemonId || event.sequence > previous.sequence + 1);
      // Refetch the question on a change notification, and also when a notification may have been missed.
      if (event.type === 'feedback-changed' || event.type === 'resync-required' || gap) {
        setFeedbackSignal((value) => value + 1);
      }
      if (event.type === 'render-diagnostics') setRenderSignal((value) => value + 1);
      if (event.type !== 'hello' || gap) void load();
    };
    const stream = api.events({
      onEvent,
      // After reconnecting, refetch the list and the question to pick up changes made while disconnected.
      onConnect: () => {
        setNotice(null);
        setFeedbackSignal((value) => value + 1);
        void load();
      },
    });
    return () => stream.close();
  }, [api, load, setActiveId]);

  const active = useMemo(
    () => documents.find((document) => document.documentId === activeId) ?? null,
    [documents, activeId],
  );

  const reorder = (order: string[]) => {
    // Reorder the view first; if saving fails, refetch.
    setCatalog((current) => ({
      ...current,
      documents: order.flatMap((documentId) =>
        current.documents.filter((document) => document.documentId === documentId),
      ),
    }));
    void api.reorder(order, catalog.version).then(load, load);
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
            activeId={activeId}
            view={view}
            onViewChange={setView}
            onSelect={(documentId) => {
              setActiveId(documentId);
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
          <DocumentWorkspace
            key={active.documentId}
            api={api}
            document={active}
            feedbackSignal={feedbackSignal}
            renderSignal={renderSignal}
            sectionTarget={sectionTarget?.documentId === active.documentId ? sectionTarget : null}
          />
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
  const [session, setSession] = useState<'loading' | 'missing' | { token: string }>('loading');

  useEffect(() => {
    void establishSession().then((token) => setSession(token ? { token } : 'missing'));
  }, []);

  const api = useMemo(
    () =>
      typeof session === 'object'
        ? createApi(session.token, () => {
            forgetSession();
            setSession('missing');
          })
        : null,
    [session],
  );

  if (session === 'loading') return null;
  if (!api) {
    return (
      <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-3 p-8">
        <h1 className="text-xl font-semibold">Open again from the CLI</h1>
        <p className="text-sm text-muted-foreground">
          This UI must be opened from the one-time URL that the CLI issues. Run{' '}
          <code className="rounded bg-muted px-1.5 py-0.5">vo ui</code> in your terminal.
        </p>
      </main>
    );
  }
  return <Workspace api={api} />;
}
