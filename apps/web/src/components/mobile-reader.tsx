import { HTML_LINK_HELLO, encodeLogicalPath, localImagePath } from '@vde-open/document';
import { MarkdownView } from '@vde-open/document/react';
import type { MobileDocument, MobileEvent, MobileGrantResult } from '@vde-open/shared';
import { ChevronLeft, LoaderCircle, RefreshCw } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { DrawerPanel, DrawerToggle } from '@/components/drawer';
import { FormatIcon } from '@/components/format-icon';
import { ImageCanvas } from '@/components/image-viewer';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import type { MobileApi, MobileCatalog } from '@/lib/mobile-api';
import { createRefresher } from '@/lib/refresher';
import { useMarkdown } from '@/lib/use-markdown';

// The phone reader (ADR-0017): the open documents of the PC, read on the phone. Choosing, scrolling, and using a
// demo stay on the phone; nothing here changes what the PC shows.

export const NOT_OPEN_NOTICE = 'Open this document on the PC to read it here.';
export const CLOSED_NOTICE = 'That document is no longer open on the PC.';

const DOCUMENT_PARAM = 'document';
const DRAWER_TOGGLE = 'mobile-drawer-toggle';
const DRAWER_PANEL = 'mobile-document-list';
const documentInUrl = () => new URLSearchParams(window.location.search).get(DOCUMENT_PARAM);
const urlOf = (documentId: string | null) => {
  const url = new URL(window.location.href);
  if (documentId === null) url.searchParams.delete(DOCUMENT_PARAM);
  else url.searchParams.set(DOCUMENT_PARAM, documentId);
  return `${url.pathname}${url.search}${url.hash}`;
};

type Phase = 'connecting' | 'ready' | 'failed';

// The history state of a document entry added by this screen.
interface DocumentEntry {
  depth: number;
  fromList: boolean;
}

export function MobileReader({ api }: { api: MobileApi }) {
  const [catalog, setCatalog] = useState<MobileCatalog | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [selected, setSelected] = useState<string | null>(documentInUrl);
  const [notice, setNotice] = useState<string | null>(null);
  // The document drawer of the reader (narrow screens show the list as a drawer, as in the management UI).
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Closing the drawer while focus is on one of its rows (Escape, or choosing a document) puts focus back on its
  // toggle, so keyboard users are not left on a hidden row. Focus elsewhere stays where it is.
  const returnFocus = useRef(false);
  const closeDrawerFromInside = useCallback(() => {
    returnFocus.current =
      document.getElementById(DRAWER_PANEL)?.contains(document.activeElement) === true;
    setDrawerOpen(false);
  }, []);
  useEffect(() => {
    if (drawerOpen || !returnFocus.current) return;
    returnFocus.current = false;
    document.getElementById(DRAWER_TOGGLE)?.focus();
  }, [drawerOpen]);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawerFromInside();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, closeDrawerFromInside]);
  // Input reaches a demo only while the stream is connected and the page is visible.
  const [connected, setConnected] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  // Counts finished revalidations (not plain list refreshes). A shown view checks its grant again on each.
  const [revalidation, setRevalidation] = useState(0);
  // Revalidations asked for and not finished, and whether the last one succeeded. Input to a demo waits for both:
  // the latest list and a check of the shown grant.
  const [outstanding, setOutstanding] = useState(0);
  const [lastLoadOk, setLastLoadOk] = useState(false);

  const load = useMemo(
    () =>
      createRefresher(async () => {
        try {
          const next = await api.documents();
          setCatalog(next);
          setPhase('ready');
        } catch (error) {
          setPhase((current) => (current === 'ready' ? current : 'failed'));
          throw error;
        }
      }),
    [api],
  );

  // Ask for the list again. Input to a demo stops from now until it and the check of the shown grant succeed.
  const revalidate = useCallback(() => {
    setOutstanding((value) => value + 1);
    void load().then((ok) => {
      setLastLoadOk(ok);
      if (ok) setRevalidation((value) => value + 1);
      setOutstanding((value) => value - 1);
    });
  }, [load]);
  // A change to another document while connected only refreshes the list; the demo keeps its input.
  const onStreamEvent = useEffectEvent((event: MobileEvent) => {
    if (event.type === 'daemon-stopping') setConnected(false);
    else if (
      event.type === 'changed' &&
      event.documentId !== undefined &&
      event.documentId !== selected
    ) {
      void load();
    } else revalidate();
  });

  useEffect(() => {
    const stream = api.events({
      onConnect: () => {
        setConnected(true);
        revalidate();
      },
      onEvent: (event) => onStreamEvent(event),
      onDisconnect: () => setConnected(false),
    });
    // Back from the lock screen, another tab, or the history cache: check everything again before going on.
    const onVisibility = () => {
      const now = document.visibilityState === 'visible';
      setVisible(now);
      if (now) revalidate();
    };
    const onPageShow = () => revalidate();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      stream.close();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [api, revalidate]);

  // Back and forward move between the list and documents of this phone only.
  useEffect(() => {
    const onPopState = () => {
      setDrawerOpen(false);
      setNotice(null);
      setSelected(documentInUrl());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Choosing the shown document again adds no history entry. Each document entry this screen adds records how many
  // document entries lie between it and the list (if the chain started at the list), for its own back button.
  const open = useCallback(
    (documentId: string) => {
      setNotice(null);
      if (selected === documentId) return;
      const from = window.history.state as DocumentEntry | null;
      const entry: DocumentEntry =
        selected === null
          ? { depth: 1, fromList: true }
          : { depth: (from?.depth ?? 0) + 1, fromList: from?.fromList === true };
      window.history.pushState(entry, '', urlOf(documentId));
      setSelected(documentId);
    },
    [selected],
  );

  const row = catalog?.documents.find((document) => document.documentId === selected) ?? null;
  // The drawer belongs to the document view: whatever way leads back to the list closes it.
  if (row === null && drawerOpen) setDrawerOpen(false);
  // A document that is not open (closed on the PC, or an unknown ID) returns to the list, saying why.
  if (catalog !== null && selected !== null && row === null) {
    setSelected(null);
    setNotice(CLOSED_NOTICE);
  }
  // Keep the URL on the list then, so a reload or Back does not ask for the closed document again.
  useEffect(() => {
    if (selected === null && documentInUrl() !== null) {
      window.history.replaceState(null, '', urlOf(null));
    }
  }, [selected]);

  useEffect(() => {
    document.title = row === null ? 'vo' : `vo - ${row.title}`;
  }, [row]);

  const live = connected && visible && outstanding === 0 && lastLoadOk;
  // Back to the list: through history to the list entry this chain started from; a chain that began with a document
  // opened directly by URL goes to the list URL instead (going back would leave the site or do nothing).
  const toList = () => {
    const entry = window.history.state as DocumentEntry | null;
    if (entry?.fromList === true && entry.depth > 0) {
      window.history.go(-entry.depth);
      return;
    }
    window.history.pushState(null, '', urlOf(null));
    setNotice(null);
    setSelected(null);
  };
  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b bg-chrome px-2">
        {row !== null ? (
          <>
            <Button variant="ghost" size="sm" onClick={toList} aria-label="Back to the documents">
              <ChevronLeft aria-hidden="true" />
              Documents
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{row.title}</h1>
            {/* Switching documents without leaving the reader. Distinct from going back to the list. */}
            <DrawerToggle
              id={DRAWER_TOGGLE}
              open={drawerOpen}
              controls={DRAWER_PANEL}
              onToggle={() => setDrawerOpen((current) => !current)}
              label="Switch document"
              iconOnly
            />
          </>
        ) : (
          <h1 className="flex-1 px-2 text-sm font-medium">Open documents</h1>
        )}
        {!connected && phase === 'ready' && (
          <span role="status" className="shrink-0 px-2 text-xs text-muted-foreground">
            Reconnecting…
          </span>
        )}
      </header>
      {notice !== null && (
        <p role="status" className="border-b bg-muted px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {row !== null && catalog !== null ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <DrawerPanel id={DRAWER_PANEL} open={drawerOpen}>
            <div className="h-full overflow-y-auto">
              <DocumentRows
                documents={catalog.documents}
                current={row.documentId}
                onOpen={(documentId) => {
                  closeDrawerFromInside();
                  open(documentId);
                }}
              />
            </div>
          </DrawerPanel>
          <DocumentView
            // A new daemon start or another document is a new view.
            key={`${catalog.daemonId}\n${row.documentId}`}
            api={api}
            row={row}
            live={live}
            revalidation={revalidation}
            onOpen={open}
            onNotice={setNotice}
            onStale={revalidate}
          />
        </div>
      ) : (
        <DocumentList
          catalog={catalog}
          phase={phase}
          onOpen={open}
          onRetry={() => {
            setPhase('connecting');
            revalidate();
          }}
        />
      )}
    </div>
  );
}

function DocumentList({
  catalog,
  phase,
  onOpen,
  onRetry,
}: {
  catalog: MobileCatalog | null;
  phase: Phase;
  onOpen: (documentId: string) => void;
  onRetry: () => void;
}) {
  if (catalog === null) {
    return phase === 'failed' ? (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
        <p role="alert">Could not load the documents from the PC.</p>
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Try again
        </Button>
      </main>
    ) : (
      <main className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Connecting to the PC…
      </main>
    );
  }
  if (catalog.documents.length === 0) {
    return (
      <main className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        No documents are open on the PC.
      </main>
    );
  }
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <DocumentRows documents={catalog.documents} current={null} onOpen={onOpen} />
    </main>
  );
}

// The rows of the open documents, for the list page and the drawer. Reading only: no PC operations.
function DocumentRows({
  documents,
  current,
  onOpen,
}: {
  documents: MobileDocument[];
  current: string | null;
  onOpen: (documentId: string) => void;
}) {
  return (
    <nav aria-label="Open documents">
      <ul>
        {documents.map((document) => (
          <li key={document.documentId} className="border-b">
            <button
              type="button"
              className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left active:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
              aria-current={document.documentId === current ? 'page' : undefined}
              onClick={() => onOpen(document.documentId)}
            >
              <FormatIcon format={document.format} />
              <span className="min-w-0 flex-1 break-words">{document.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

interface Shown {
  // The listed state this view was prepared for.
  revision: string;
  viewEpoch: string;
  effectiveMode: MobileDocument['effectiveMode'];
  nonce: number;
  grant: MobileGrantResult;
  text: string | null;
  // The revalidation count when it was prepared: a view prepared after the latest check needs no other.
  checkedAt: number;
}

// Whether the view on screen may stay (without input) until the next one is ready: only when exactly one change
// happened since it was prepared, and that change was a new revision in the same open and mode. Its grant is dead
// by then (phone grants need the current revision); only what it already loaded stays. A permission change, a
// close, a dead grant, or several changes (which may hide a revoke and a re-grant) drop it at once.
export function canKeepShown(shown: Shown, row: MobileDocument, nonce: number): boolean {
  const [shownOpen, shownGeneration] = shown.viewEpoch.split('.').map(Number);
  const [rowOpen, rowGeneration] = row.viewEpoch.split('.').map(Number);
  return (
    shown.nonce === nonce &&
    shown.effectiveMode === row.effectiveMode &&
    shown.revision !== row.revision &&
    shownOpen === rowOpen &&
    rowGeneration === (shownGeneration ?? Number.NaN) + 1
  );
}

function DocumentView({
  api,
  row,
  live,
  revalidation,
  onOpen,
  onNotice,
  onStale,
}: {
  api: MobileApi;
  row: MobileDocument;
  live: boolean;
  revalidation: number;
  onOpen: (documentId: string) => void;
  onNotice: (notice: string | null) => void;
  onStale: () => void;
}) {
  // Advanced when the grant is found dead (or was released for the history cache): prepare a new view.
  const [nonce, setNonce] = useState(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  // The last grant a revalidation found alive. Until then, input does not reach the demo.
  const [checked, setChecked] = useState<{ grant: string; revalidation: number } | null>(null);
  // Grants issued and not yet released.
  const issued = useRef(new Set<string>());
  const key = `${row.revision ?? ''}\n${row.viewEpoch}\n${String(nonce)}`;
  const current =
    shown !== null &&
    shown.revision === row.revision &&
    shown.viewEpoch === row.viewEpoch &&
    shown.nonce === nonce;
  const display = shown !== null && (current || canKeepShown(shown, row, nonce)) ? shown : null;
  const displayed = display?.grant.grant ?? null;
  // The grant of the view for the listed state (not one kept while the next is prepared).
  const currentGrant = current ? shown.grant.grant : null;

  // Prepare the view of the listed state: a grant (and the Markdown source). A late answer for an earlier state
  // is never shown; its grant is released.
  const { documentId, revision, viewEpoch, format, effectiveMode } = row;
  const latestRevalidation = useRef(revalidation);
  useEffect(() => {
    latestRevalidation.current = revalidation;
  });
  const reportStale = useEffectEvent(() => onStale());
  useEffect(() => {
    if (revision === null) return undefined;
    let cancelled = false;
    const listed = { documentId, revision, viewEpoch };
    const failureKey = `${revision}\n${viewEpoch}\n${String(nonce)}`;
    // The grant belongs to this request until it is handed to the screen; a cancelled or failed request returns it.
    let pending: string | null = null;
    const giveBack = () => {
      if (pending !== null) void api.release([pending]).catch(() => undefined);
      pending = null;
    };
    void (async () => {
      const grant = await api.grant(listed);
      pending = grant.grant;
      if (cancelled) {
        giveBack();
        return;
      }
      const text = format === 'markdown' ? await api.content(listed) : null;
      if (cancelled) {
        giveBack();
        return;
      }
      issued.current.add(grant.grant);
      pending = null;
      setShown({
        revision,
        viewEpoch,
        effectiveMode,
        nonce,
        grant,
        text,
        checkedAt: latestRevalidation.current,
      });
      setFailure(null);
    })().catch((error: unknown) => {
      giveBack();
      if (cancelled) return;
      // The list moved on: fetch it again; the new row prepares the next view.
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) {
        reportStale();
      } else {
        setFailure({
          key: failureKey,
          message: error instanceof Error ? error.message : 'Could not load.',
        });
      }
    });
    return () => {
      cancelled = true;
      // A grant waiting for its source goes back now, not when the source arrives.
      giveBack();
    };
  }, [api, documentId, revision, viewEpoch, format, effectiveMode, nonce]);

  // After every screen update, release the grants no longer on screen.
  useEffect(() => {
    const release = [...issued.current].filter((grant) => grant !== displayed);
    if (release.length === 0) return;
    for (const grant of release) issued.current.delete(grant);
    void api.release(release).catch(() => undefined);
  });
  useEffect(
    () => () => {
      const release = [...issued.current];
      issued.current.clear();
      void api.release(release).catch(() => undefined);
    },
    [api],
  );

  // Each revalidation: the listed state is unchanged, so the same view goes on if its grant still lives;
  // otherwise a new view is prepared.
  // A view kept for a new revision is not checked: its grant is expected to be dead already.
  useEffect(() => {
    if (currentGrant === null) return undefined;
    let cancelled = false;
    void api.check(currentGrant).then(
      (valid) => {
        if (cancelled) return;
        if (valid) setChecked({ grant: currentGrant, revalidation });
        else setNonce((value) => value + 1);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, currentGrant, revalidation]);

  // Leaving for the history cache releases the view; coming back from it prepares a new one.
  useEffect(() => {
    let released = false;
    const onPageHide = () => {
      const grants = [...issued.current];
      if (grants.length === 0) return;
      issued.current.clear();
      released = true;
      void api.release(grants, true).catch(() => undefined);
    };
    const onPageShow = () => {
      if (!released) return;
      released = false;
      setNonce((value) => value + 1);
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [api]);

  // The answer applies only if the view that asked is still the one on screen (not after Back or another choice).
  const onScreen = useRef<string | null>(null);
  useEffect(() => {
    onScreen.current = currentGrant;
    return () => {
      onScreen.current = null;
    };
  }, [currentGrant]);
  const openLink = useCallback(
    async (grant: string, linkId: string) => {
      try {
        const result = await api.resolveLink(grant, linkId);
        if (onScreen.current !== grant) return;
        if (result.status === 'open') onOpen(result.documentId);
        else onNotice(NOT_OPEN_NOTICE);
      } catch {
        if (onScreen.current === grant) onStale();
      }
    },
    [api, onOpen, onNotice, onStale],
  );

  const interactive =
    live &&
    display !== null &&
    currentGrant !== null &&
    (display.checkedAt === revalidation ||
      (checked?.grant === display.grant.grant && checked.revalidation === revalidation));
  if (display === null) {
    const message = failure?.key === key ? failure.message : null;
    return (
      <main className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        {message === null ? (
          <>
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Preparing the view…
          </>
        ) : (
          <span role="alert">Could not show the document ({message}).</span>
        )}
      </main>
    );
  }
  if (row.format === 'markdown') {
    return <MarkdownBody shown={display} onOpenLink={openLink} />;
  }
  if (row.format === 'image') return <ImageBody shown={display} title={row.title} />;
  return <HtmlBody shown={display} interactive={interactive} onOpenLink={openLink} />;
}

function MarkdownBody({
  shown,
  onOpenLink,
}: {
  shown: Shown;
  onOpenLink: (grant: string, linkId: string) => Promise<void>;
}) {
  const markdown = useMarkdown(shown.text);
  const { grant } = shown;
  const resolveImage = useMemo(() => {
    const images = new Set(
      grant.assets
        .filter((asset) => asset.role === 'image' || asset.role === 'svg')
        .map((asset) => asset.logicalPath),
    );
    return (src: string): string | null => {
      const logicalPath = localImagePath(src, grant.documentLogicalPath);
      if (logicalPath === null || !images.has(logicalPath)) return null;
      return `${grant.filesBaseUrl}${encodeLogicalPath(logicalPath)}`;
    };
  }, [grant]);
  const openLink = useCallback(
    (href: string) => {
      const link = grant.links.find(
        (candidate) => candidate.href === href && candidate.kind === 'document',
      );
      if (link) void onOpenLink(grant.grant, link.linkId);
    },
    [grant, onOpenLink],
  );
  let body: ReactNode;
  if (markdown.status === 'ready') {
    body = (
      <article className="markdown-body mx-auto max-w-3xl px-4 py-4" data-testid="markdown-body">
        <MarkdownView
          document={markdown.document}
          resolveImage={resolveImage}
          onOpenLink={openLink}
        />
      </article>
    );
  } else if (markdown.status === 'parsing') {
    body = <p className="p-4 text-sm text-muted-foreground">Preparing the view…</p>;
  } else {
    body = (
      <pre className="p-4 font-mono text-sm break-words whitespace-pre-wrap">{shown.text}</pre>
    );
  }
  return <main className="min-h-0 flex-1 overflow-y-auto">{body}</main>;
}

// The same image view as the PC (fit to the screen, a decode failure explained). A new grant is a new image.
function ImageBody({ shown, title }: { shown: Shown; title: string }) {
  const [result, setResult] = useState<{ url: string; failed: boolean } | null>(null);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <ImageCanvas
        url={shown.grant.documentUrl}
        title={title}
        actualSize={false}
        result={result}
        failure={null}
        onResult={setResult}
      />
    </main>
  );
}

function HtmlBody({
  shown,
  interactive,
  onOpenLink,
}: {
  shown: Shown;
  interactive: boolean;
  onOpenLink: (grant: string, linkId: string) => Promise<void>;
}) {
  const { grant } = shown;
  const frame = useRef<HTMLIFrameElement>(null);
  const hasDocumentLinks = grant.links.some((link) => link.kind === 'document');
  // Only a frame that runs the document's scripts is blocked while unchecked. A static frame runs nothing but the link
  // relay and stays scrollable; its link taps are ignored below until the view is checked again.
  const blocked = !interactive && grant.mode === 'interactive';
  // Taps on links count only while input reaches the view.
  const follow = useEffectEvent((linkId: string) => {
    if (!interactive) return;
    const link = grant.links.find(
      (candidate) => candidate.kind === 'document' && candidate.linkId === linkId,
    );
    if (link) void onOpenLink(grant.grant, link.linkId);
  });

  // Document links from the view: only from this frame's window, an opaque origin, a port handed over once, and a
  // link ID of this view. The frame never gets the answer SDK or the same origin as this screen.
  useEffect(() => {
    const element = frame.current;
    if (!element || !hasDocumentLinks) return undefined;
    let closePort: (() => void) | undefined;
    const onPortMessage = ({ data }: MessageEvent<unknown>) => {
      if (typeof data === 'string') follow(data);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        event.source === null ||
        event.source !== element.contentWindow ||
        event.origin !== 'null' ||
        event.data !== HTML_LINK_HELLO ||
        event.ports.length !== 1
      )
        return;
      const [incoming] = event.ports;
      if (!incoming) return;
      if (closePort && grant.mode === 'interactive') {
        incoming.close();
        return;
      }
      closePort?.();
      incoming.addEventListener('message', onPortMessage);
      incoming.start();
      closePort = () => {
        incoming.removeEventListener('message', onPortMessage);
        incoming.close();
      };
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      closePort?.();
    };
  }, [grant, hasDocumentLinks]);

  return (
    <main className="relative min-h-0 flex-1">
      <iframe
        // A new grant is a new frame: nothing of the previous view stays.
        key={grant.grant}
        ref={frame}
        title={`View of ${grant.documentLogicalPath}`}
        src={grant.documentUrl ?? undefined}
        sandbox={grant.mode === 'interactive' || hasDocumentLinks ? 'allow-scripts' : ''}
        referrerPolicy="no-referrer"
        className="size-full border-0 bg-white"
        data-testid="document-frame"
        data-mode={grant.mode}
        inert={blocked}
      />
      {blocked && (
        // Covers the frame while the connection or the view is being checked, so taps do not reach the demo.
        <div className="absolute inset-0" data-testid="frame-paused" aria-hidden="true" />
      )}
    </main>
  );
}
