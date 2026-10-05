import {
  classifyReference,
  dirnameOfLogicalPath,
  encodeLogicalPath,
  fragmentOfAnchor,
} from '@vde-open/document';
import { codeOfBlock, MarkdownView } from '@vde-open/document/react';
import type { DocumentSummary, FeedbackForUi, OutlineItem } from '@vde-open/shared';
import { Copy, Hash, Pause, Play, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ApiError, type Api } from '@/lib/api';
import { describeDiagnostic } from '@/lib/diagnostics';
import type { HeadingInUrl, HeadingRestore } from '@/lib/location';
import { isViewMode, usePreference, type ViewMode } from '@/lib/preferences';
import { useBridge, type BridgeStatus } from '@/lib/use-bridge';
import { useCopy } from '@/lib/use-copy';
import { useMarkdown } from '@/lib/use-markdown';
import { useMissingAssets } from '@/lib/use-missing-assets';
import { useRenderGrant } from '@/lib/use-render-grant';

const PARSE_FAILURE: Record<string, string> = {
  timeout: 'Parsing did not finish within 2 seconds, so the source is shown.',
  'limit-nodes': 'The document has more than 100,000 elements, so the source is shown.',
  'limit-depth': 'The document is nested deeper than 64 levels, so the source is shown.',
  'parse-error': 'The document could not be parsed, so the source is shown.',
};

const SOURCE_STATE: Record<string, string> = {
  missing: 'The file was not found. Showing the last content that could be read.',
  unreadable: 'No permission to read the file. Showing the last content that could be read.',
  error: 'The file cannot be read as a document. Showing the last content that could be read.',
};

export interface ViewerProps {
  api: Api;
  document: DocumentSummary;
  // The revision pinned by a question awaiting an answer. If set, keep showing it even when a newer revision arrives (spec 11.4).
  fixedRevision?: string | null;
  // The question for this document. If it is a pending question created in interactive mode, accept draft answers from the HTML.
  request?: FeedbackForUi | null;
  // How many times the view tried to load an unregistered file.
  renderSignal?: number;
  // Until the pending question is fetched, do not decide which revision to show (never show a revision other than the question's, even once).
  waitingForRequest?: boolean;
  // The section to jump to from a search result. In the Markdown preview, jump to that heading.
  sectionTarget?: SectionTarget | null;
  // The heading the URL keeps for this document (a reload, back or forward). Each request (id) is handled once, when
  // the view can jump.
  restoreHeading?: HeadingRestore | null;
  // Called with the heading the view jumped to, or null when the heading to restore is not in the view any more.
  onHeadingShown?: (heading: HeadingInUrl | null) => void;
}

// The target to jump to from a search result. The result is a section of the revision that was searched, so keep it with the revision.
// nonce changes when jumping to the same section again.
export interface SectionTarget {
  sectionId: string;
  revision: string;
  nonce: number;
}

// Explanations for why communication with the HTML ended.
const BRIDGE_CLOSED: Record<string, string> = {
  navigated:
    'The document view was reloaded, so draft answers from this document are no longer accepted.',
  'request-closed':
    'The question is closed, so draft answers from this document are no longer accepted.',
  expired: 'The render grant expired, so draft answers from this document are no longer accepted.',
  replaced: 'Draft answers from this document are no longer accepted.',
};

function bridgeNotice(status: BridgeStatus): string | null {
  if (status.status === 'connected') {
    return 'Accepting draft answers from the scripts in this document. Answers are submitted only with "Send answers to the agent" on the right.';
  }
  if (status.status !== 'closed') return null;
  return (
    BRIDGE_CLOSED[status.reason] ??
    'The scripts in this document sent a message that breaks the rules (too large, too many, malformed, or similar), so draft answers are no longer accepted.'
  );
}

// The content being shown. The body and the outline are kept with the revision they were fetched for.
interface Loaded {
  revision: string;
  text: string;
  outline: OutlineItem[];
  // Why the outline could not be fetched. The body is still shown.
  outlineError: string | null;
}

// The revision that could not be loaded, and why. Kept separate from the content being shown (the previous revision).
interface LoadFailure {
  revision: string;
  message: string;
}

// Confirmation before opening an unregistered document. path is the absolute path the daemon resolved.
// The confirmation is tied to the revision and target at the time it was requested. When confirming, send that revision and identifier.
interface PendingLink {
  linkId: string;
  revision: string;
  path: string;
  confirmation: string;
  // The previous confirmation did not hold (the target changed or it expired).
  changed: boolean;
}

// The first element inside root with the id. Compared as is, so any id works without escaping.
function elementWithId(root: HTMLElement | null, id: string): Element | null {
  if (root === null) return null;
  for (const element of root.querySelectorAll('[id]')) if (element.id === id) return element;
  return null;
}

// Recreated when the document changes (the caller passes documentId as key).
export function Viewer({
  api,
  document,
  fixedRevision = null,
  request = null,
  renderSignal = 0,
  waitingForRequest = false,
  sectionTarget = null,
  restoreHeading = null,
  onHeadingShown,
}: ViewerProps) {
  const [mode, setMode] = usePreference<ViewMode>('view-mode', 'preview', isViewMode);
  // The revision at the time updates were paused. While paused, do not replace it with newer revisions.
  const [pinnedRevision, setPinnedRevision] = useState<string | null>(null);
  const paused = pinnedRevision !== null;
  // If a question is awaiting an answer, show the question's revision (keep the revision the answer is recorded for and the one being viewed the same).
  // Meanwhile, pausing or resuming updates does not change the revision shown.
  const fixed = fixedRevision !== null;
  const shownRevision = waitingForRequest
    ? null
    : (fixedRevision ?? pinnedRevision ?? document.revision);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);

  useEffect(() => {
    if (shownRevision === null) return undefined;
    let cancelled = false;
    // Remember the reading position before the content is replaced.
    savedScroll.current = scroller.current?.scrollTop ?? 0;
    void Promise.all([
      api.content(document.documentId, shownRevision),
      // Show the body even if the outline cannot be fetched. Report the failure where the outline would be.
      api.outline(document.documentId, shownRevision).then(
        (items) => ({ items, error: null }),
        (reason: unknown) => ({
          items: [] as OutlineItem[],
          error: reason instanceof Error ? reason.message : 'Could not be fetched.',
        }),
      ),
    ]).then(
      ([content, outline]) => {
        if (cancelled) return;
        setLoaded({
          revision: shownRevision,
          text: content,
          outline: outline.items,
          outlineError: outline.error,
        });
        setFailure(null);
      },
      (reason: unknown) => {
        if (cancelled) return;
        // Keep the content being shown (the previous revision) and treat it as still that revision.
        setFailure({
          revision: shownRevision,
          message: reason instanceof Error ? reason.message : 'Could not be loaded.',
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, document.documentId, shownRevision]);

  // While the next revision is loading, and while it failed to load, keep showing the previous content.
  const text = loaded?.text ?? null;
  const outline = loaded?.outline ?? [];
  const outlineError = loaded?.outlineError ?? null;
  const error = failure !== null && failure.revision === shownRevision ? failure.message : null;

  const isMarkdown = document.format === 'markdown';
  const wantsPreview = mode === 'preview';
  const markdown = useMarkdown(isMarkdown && wantsPreview ? text : null);
  // While showing a question awaiting an answer, use the revision and view mode the question pinned (spec 11.4).
  // The daemon decides the view mode from the question (a question created in static mode stays static even if scripts are allowed later).
  // If the question was created in interactive mode, accept draft answers from the HTML.
  const pinnedRequestId =
    fixedRevision !== null && request?.status === 'pending' && request.revision === fixedRevision
      ? request.requestId
      : null;
  const pinnedStatic = pinnedRequestId !== null && request?.renderMode === 'static';
  // Otherwise, run scripts only for HTML the user explicitly allowed (spec 10.2).
  const interactive =
    !isMarkdown && document.htmlMode === 'interactive' && document.interactiveAllowed;
  // Incremented when the view is recreated (communication restarts as a new view).
  const [frameNonce, setFrameNonce] = useState(0);
  const grantState = useRenderGrant(api, document.documentId, shownRevision, document.updatedAt, {
    mode: interactive ? 'interactive' : 'static',
    requestId: pinnedRequestId,
    nonce: frameNonce,
  });
  const grant = grantState.status === 'ready' ? grantState.grant : null;
  const missing = useMissingAssets(api, grant?.grant ?? null, renderSignal);
  const [confirmingInteractive, setConfirmingInteractive] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const changeMode = (next: 'static' | 'interactive') => {
    setConfirmingInteractive(false);
    setModeError(null);
    void api
      .setHtmlMode(document.documentId, next)
      .catch((reason: unknown) =>
        setModeError(reason instanceof Error ? reason.message : 'Could not change the view mode.'),
      );
  };

  const showMarkdown = isMarkdown && wantsPreview && markdown.status === 'ready';
  // HTML shows the converted content inside a sandbox on a different origin.
  const frameUrl = !isMarkdown && wantsPreview ? (grant?.documentUrl ?? null) : null;
  // Communication with the HTML lasts only while the iframe is on screen. Removing it ends the communication.
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useBridge(api, frame, frameUrl !== null ? grant : null, request);

  // Restore the reading position each time the content is replaced.
  useLayoutEffect(() => {
    if (scroller.current && (text !== null || showMarkdown)) {
      scroller.current.scrollTop = savedScroll.current;
    }
  }, [text, showMarkdown]);

  // Markdown images load only registered local files, from the render URL.
  const resolveImage = useMemo(() => {
    if (!grant) return undefined;
    const images = new Set(
      grant.assets
        .filter((asset) => asset.role === 'image' || asset.role === 'svg')
        .map((asset) => asset.logicalPath),
    );
    const baseDir = dirnameOfLogicalPath(grant.documentLogicalPath);
    return (src: string): string | null => {
      const reference = classifyReference(src, baseDir);
      if (reference.kind !== 'local' || !images.has(reference.logicalPath)) return null;
      return `${grant.filesBaseUrl}${encodeLogicalPath(reference.logicalPath)}`;
    };
  }, [grant]);

  // Open a link to a local document. For unregistered documents, show the path and confirm before opening.
  const openLink = useCallback(
    async (linkId: string, revision: string, confirmation?: string) => {
      setLinkError(null);
      try {
        await api.openLink(document.documentId, revision, linkId, confirmation);
        setPendingLink(null);
      } catch (reason) {
        if (reason instanceof ApiError && reason.code === 'E_CONFIRMATION_REQUIRED') {
          setPendingLink({
            linkId,
            revision,
            path: String(reason.details['path'] ?? ''),
            confirmation: String(reason.details['confirmation'] ?? ''),
            changed: reason.details['changed'] === true,
          });
          return;
        }
        setPendingLink(null);
        setLinkError(reason instanceof Error ? reason.message : 'Could not open the link.');
      }
    },
    [api, document.documentId],
  );
  const openMarkdownLink = useCallback(
    (href: string) => {
      const link = grant?.links.find((candidate) => candidate.href === href);
      if (grant && link?.kind === 'document') void openLink(link.linkId, grant.revision);
    },
    [grant, openLink],
  );

  // Copy the document path, ID, and code (spec 13.2). The result is shown in the status row.
  const { result: copied, copy } = useCopy();
  const codeActions = useMemo(
    () => (
      <Button
        variant="outline"
        size="xs"
        onClick={(event) => void copy('code', codeOfBlock(event.currentTarget))}
      >
        <Copy aria-hidden="true" />
        Copy code
      </Button>
    ),
    [copy],
  );

  const stale = paused && !fixed && document.revision !== shownRevision;
  // Outline items the HTML view can be moved to (sectionId to anchor). Two headings can share an anchor, so items are
  // matched by sectionId.
  const frameTargets = useMemo(
    () => new Map(grant?.headingTargets.map((target) => [target.sectionId, target.anchor]) ?? []),
    [grant],
  );
  // Why no outline item can be jumped to in this view, or null when the items can be.
  const outlineUnavailable = showMarkdown
    ? null
    : frameUrl === null
      ? isMarkdown
        ? 'Available in the Markdown preview'
        : 'Available in the HTML preview'
      : grant?.mode !== 'static'
        ? 'Not available in the Interactive view (jumping reloads the view and restarts its scripts)'
        : loaded?.revision !== grant.revision
          ? 'Available once the outline of the shown revision has loaded'
          : null;
  const canJump = (item: OutlineItem) =>
    outlineUnavailable === null &&
    (showMarkdown || frameTargets.get(item.sectionId) === item.anchor);
  const jumpTo = useCallback(
    (item: OutlineItem) => {
      if (showMarkdown) {
        // Only the Markdown body is searched, so an id of this UI is never hit.
        elementWithId(scroller.current, item.anchor)?.scrollIntoView({ block: 'start' });
        return;
      }
      if (frameUrl === null) return;
      // The view is on another origin, so only its location can be set. Chromium and WebKit load the document again
      // to move to the heading (Firefox only scrolls). replace adds no history entry.
      frame.current?.contentWindow?.location.replace(
        `${frameUrl}#${fragmentOfAnchor(item.anchor)}`,
      );
    },
    [showMarkdown, frameUrl],
  );
  // Jump to the heading of the section chosen from search results (after the outline and body of the shown revision are loaded).
  // If the result's revision differs from the shown revision, the section number may point to a different heading, so do not jump and explain why.
  // Do not change the view of the question's revision or of the paused revision.
  const targetNonce = sectionTarget?.nonce ?? 0;
  const [dismissedNonce, setDismissedNonce] = useState(0);
  // Do not compare until the content of the shown revision has loaded. While it failed to load, the previous
  // revision's content is shown, so do not jump.
  const targetLoaded =
    sectionTarget !== null && shownRevision !== null && loaded?.revision === shownRevision;
  const targetMatches = targetLoaded && sectionTarget.revision === shownRevision;
  const targetItem =
    targetMatches && showMarkdown
      ? (outline.find((item) => item.sectionId === sectionTarget.sectionId) ?? null)
      : null;
  const targetNotice =
    sectionTarget === null || targetNonce === dismissedNonce
      ? null
      : !targetLoaded
        ? error !== null
          ? 'The revision to show could not be loaded, so the view did not jump to the section.'
          : null
        : !targetMatches
          ? fixed
            ? "The search result is in a different revision than the one shown. The view is showing the question's revision while awaiting an answer, so it did not jump."
            : paused
              ? 'The search result is in a different revision than the one shown. Updates are paused, so the view did not jump.'
              : 'The document was updated after the search, so the view did not jump to the section. Search again.'
          : showMarkdown
            ? null
            : 'This view does not jump to sections (only the Markdown preview does).';
  useEffect(() => {
    if (targetItem === null || targetNonce === 0) return;
    jumpTo(targetItem);
    onHeadingShown?.({ sectionId: targetItem.sectionId, title: targetItem.title });
  }, [targetItem, targetNonce, jumpTo, onHeadingShown]);

  // Jump again to the heading the URL keeps, once the view of the shown revision can jump. A heading added above moves
  // the section number, so the title decides: the same section with that title, else the first heading with that title.
  // A heading that is no longer there, or that this view cannot reach, is dropped from the URL. Each request once.
  const restoreReady =
    restoreHeading !== null &&
    outlineUnavailable === null &&
    shownRevision !== null &&
    loaded?.revision === shownRevision &&
    outlineError === null;
  const restoreItem = restoreReady
    ? (outline.find(
        (item) =>
          item.sectionId === restoreHeading.sectionId && item.title === restoreHeading.title,
      ) ??
      outline.find((item) => item.title === restoreHeading.title) ??
      null)
    : null;
  const restoreJumpable = restoreItem !== null && canJump(restoreItem);
  const restoreId = restoreHeading?.id ?? null;
  const restoredId = useRef<number | null>(null);
  useEffect(() => {
    if (!restoreReady || restoreId === null || restoredId.current === restoreId) return;
    restoredId.current = restoreId;
    if (restoreItem === null || !restoreJumpable) {
      onHeadingShown?.(null);
      return;
    }
    jumpTo(restoreItem);
    onHeadingShown?.({ sectionId: restoreItem.sectionId, title: restoreItem.title });
  }, [restoreReady, restoreId, restoreItem, restoreJumpable, jumpTo, onHeadingShown]);
  const diagnostics = [
    ...(grant?.diagnostics ?? []),
    ...missing.map((path) => ({ code: 'asset-requested', target: path, count: 1 })),
  ];
  const notice = bridgeNotice(bridge);
  // Show the view mode exactly as the render grant issued by the daemon says.
  const frameMode = grant?.mode ?? 'static';
  // HTML links cannot be clicked inside the view, so they are opened from the list. Markdown links can be opened from the body.
  const links = isMarkdown ? [] : (grant?.links ?? []);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col" aria-label="Document view">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="truncate text-base font-semibold">{document.title}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {document.displayPath ?? '(opened from stdin)'}
            {shownRevision && (
              <span title={shownRevision}> · Revision {shownRevision.slice(4, 12)}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {document.displayPath !== null && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy document path"
              title="Copy document path"
              onClick={() => void copy('document path', document.displayPath ?? '')}
            >
              <Copy aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy document ID"
            title={`Copy document ID (${document.documentId})`}
            onClick={() => void copy('document ID', document.documentId)}
          >
            <Hash aria-hidden="true" />
          </Button>
        </div>
        <Badge variant="outline">{isMarkdown ? 'Markdown' : 'HTML'}</Badge>
        {!isMarkdown && (
          <Badge variant="outline" data-testid="html-mode">
            {frameMode === 'interactive' ? 'Interactive view (scripts run)' : 'Static view'}
          </Badge>
        )}
        {fixed ? (
          <Badge variant="secondary">Showing the question's revision</Badge>
        ) : (
          paused && <Badge variant="secondary">Updates paused</Badge>
        )}
        <ToggleGroup
          value={[mode]}
          onValueChange={(value) => {
            const next: unknown = value[0];
            if (!isViewMode(next)) return;
            // HTML that returns from Source to Preview starts communication as a new view (the port is handed over once per view).
            if (next === 'preview' && mode !== 'preview' && !isMarkdown) {
              setFrameNonce((nonce) => nonce + 1);
            }
            setMode(next);
          }}
          size="sm"
          aria-label="View"
        >
          <ToggleGroupItem value="preview">Preview</ToggleGroupItem>
          <ToggleGroupItem value="source">Source</ToggleGroupItem>
        </ToggleGroup>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={paused}
          disabled={fixed}
          title={
            fixed
              ? "A question is awaiting an answer, so the question's revision is shown"
              : undefined
          }
          onClick={() => setPinnedRevision(paused ? null : document.revision)}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {paused ? 'Resume updates' : 'Pause updates'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void api.refresh(document.documentId).catch(() => undefined)}
        >
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </header>

      <div role="status" aria-live="polite" className="empty:hidden">
        {copied !== null && (
          <p
            className={`border-b px-4 py-2 text-sm ${copied.ok ? 'bg-muted' : 'bg-destructive/10'}`}
            data-testid="copy-result"
          >
            {copied.message}
          </p>
        )}
        {targetNotice !== null && (
          <div
            className="flex flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-sm"
            data-testid="section-target-notice"
          >
            <p className="min-w-0 flex-1">{targetNotice}</p>
            <Button variant="outline" size="sm" onClick={() => setDismissedNonce(targetNonce)}>
              Dismiss
            </Button>
          </div>
        )}
        {stale && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            A newer revision is available. Updates are paused, so the view stays on the revision
            from when they were paused.
          </p>
        )}
        {document.sourceState !== 'ready' && SOURCE_STATE[document.sourceState] && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            {SOURCE_STATE[document.sourceState]}
          </p>
        )}
        {!isMarkdown && wantsPreview && grantState.status === 'failed' && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            The HTML could not be converted for display, so the source is shown (
            {grantState.message})
          </p>
        )}
        {isMarkdown && wantsPreview && markdown.status === 'failed' && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            {PARSE_FAILURE[markdown.reason] ?? PARSE_FAILURE['parse-error']}
          </p>
        )}
        {pinnedStatic && document.interactiveAllowed && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            This question was created in the Static view, so scripts stay off until it is answered.
          </p>
        )}
        {!isMarkdown &&
          document.htmlMode === 'interactive' &&
          !document.interactiveAllowed &&
          !pinnedStatic && (
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-sm">
              <p className="min-w-0 flex-1">
                This HTML was opened in the Interactive view. The permission to run scripts was
                cleared (for example, by a daemon restart), so it is now in the Static view.
              </p>
              <Button size="sm" variant="outline" onClick={() => setConfirmingInteractive(true)}>
                Enable Interactive view
              </Button>
            </div>
          )}
        {frameMode === 'interactive' && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-sm">
            <p className="min-w-0 flex-1">
              The scripts in this document are running. Scripts can load only the files registered
              for this document and cannot reach the management UI, the management API, or your
              files. This does not block every outbound request, including page navigation inside
              the view.
            </p>
            <Button size="sm" variant="outline" onClick={() => changeMode('static')}>
              Switch to Static view
            </Button>
          </div>
        )}
        {notice !== null && (
          <div
            className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm"
            data-testid="bridge-status"
          >
            <p className="min-w-0 flex-1">{notice}</p>
            {bridge.status === 'closed' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFrameNonce((value) => value + 1)}
              >
                Reload view
              </Button>
            )}
          </div>
        )}
        {modeError && <p className="border-b bg-destructive/10 px-4 py-2 text-sm">{modeError}</p>}
        {error && <p className="border-b bg-destructive/10 px-4 py-2 text-sm">{error}</p>}
        {linkError && <p className="border-b bg-destructive/10 px-4 py-2 text-sm">{linkError}</p>}
      </div>

      {(diagnostics.length > 0 || links.length > 0) && (
        <div className="flex flex-col border-b text-sm">
          {diagnostics.length > 0 && (
            <details className="px-4 py-2" data-testid="render-diagnostics">
              <summary className="cursor-pointer">
                Differences from the original document ({diagnostics.length} kinds)
              </summary>
              {/* Even with many items, do not push the document view out of the way. */}
              <ul className="mt-2 flex max-h-40 list-disc flex-col gap-1 overflow-y-auto pl-5 text-muted-foreground">
                {diagnostics.map((diagnostic) => (
                  <li key={`${diagnostic.code}:${diagnostic.target ?? ''}`} className="break-words">
                    {describeDiagnostic(diagnostic)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {links.length > 0 && (
            <details className="border-t px-4 py-2 first:border-t-0" data-testid="render-links">
              <summary className="cursor-pointer">Links in this document ({links.length})</summary>
              <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
                {links.map((link) => (
                  <li key={link.linkId} className="flex flex-wrap items-baseline gap-x-2">
                    {link.kind === 'external' && (
                      <a
                        className="underline underline-offset-2"
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {link.text || link.href}
                      </a>
                    )}
                    {link.kind === 'document' && (
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => {
                          if (grant) void openLink(link.linkId, grant.revision);
                        }}
                      >
                        {link.text || link.href}
                      </button>
                    )}
                    {link.kind === 'other' && <span>{link.text || link.href}</span>}
                    <span className="text-xs break-all text-muted-foreground">
                      {link.href}
                      {link.kind === 'other' && ' (this kind of link cannot be opened)'}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {frameUrl ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Inside the frame is the content of the opened document. Always make clear that it is not this product's UI. */}
            <p className="border-b bg-muted px-4 py-1 text-xs text-muted-foreground">
              {frameMode === 'interactive'
                ? 'Below this line is the content of the opened document (Interactive view: these are not controls of this UI, and links and form submission are disabled).'
                : 'Below this line is the content of the opened document (Static view: scripts do not run, and links and form submission are disabled).'}
            </p>
            <iframe
              // Recreated for every view. The previous view is not kept.
              key={frameUrl}
              ref={frame}
              title={`View of ${document.title}`}
              src={frameUrl}
              // Same-origin treatment, form submission, popups, top navigation, and downloads are never allowed.
              // Only interactive allows scripts to run (spec 10.2).
              sandbox={frameMode === 'interactive' ? 'allow-scripts' : ''}
              referrerPolicy="no-referrer"
              className="min-h-0 w-full flex-1 border-0 bg-white"
              data-testid="document-frame"
            />
          </div>
        ) : (
          <div
            ref={scroller}
            className="min-w-0 flex-1 overflow-y-auto px-6 py-5"
            data-testid="document-body"
          >
            {text === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : showMarkdown ? (
              <article className="markdown-body mx-auto max-w-3xl">
                <MarkdownView
                  document={markdown.document}
                  {...(resolveImage ? { resolveImage } : {})}
                  onOpenLink={openMarkdownLink}
                  codeActions={codeActions}
                />
              </article>
            ) : !isMarkdown && wantsPreview && grantState.status === 'loading' ? (
              <p className="text-sm text-muted-foreground">Preparing the view…</p>
            ) : (
              <pre className="font-mono text-sm leading-relaxed break-words whitespace-pre-wrap">
                {text}
              </pre>
            )}
          </div>
        )}
        {(outline.length > 0 || outlineError !== null) && (
          <aside
            className="hidden w-60 shrink-0 overflow-y-auto border-l px-3 py-4 lg:block"
            aria-label="Outline"
          >
            <h2 className="mb-2 text-xs font-medium text-muted-foreground">Outline</h2>
            {outlineError !== null && (
              <p className="text-xs text-destructive" role="alert">
                Could not fetch the outline ({outlineError}).
              </p>
            )}
            <ul className="flex flex-col gap-0.5 text-sm">
              {outline.map((item) => {
                const jumpable = canJump(item);
                return (
                  <li
                    key={item.sectionId}
                    style={{ paddingLeft: `${String((item.level - 1) * 0.75)}rem` }}
                  >
                    <button
                      type="button"
                      className="w-full truncate rounded px-2 py-1 text-left hover:bg-muted disabled:opacity-50"
                      disabled={!jumpable}
                      title={
                        jumpable
                          ? item.title
                          : (outlineUnavailable ??
                            'This heading is not in the view (removed from the display, or an earlier element has the same id)')
                      }
                      onClick={() => {
                        jumpTo(item);
                        onHeadingShown?.({ sectionId: item.sectionId, title: item.title });
                      }}
                    >
                      {item.title}
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        )}
      </div>

      <AlertDialog open={confirmingInteractive} onOpenChange={setConfirmingInteractive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run the scripts in this document?</AlertDialogTitle>
            <AlertDialogDescription>
              This runs the scripts in this HTML inside your browser. Scripts can load only the
              files registered for this document and cannot reach the management UI, the management
              API, or your files. However, this does not block every outbound request, including
              page navigation inside the view, and it is not a mechanism for running arbitrary
              scripts safely. Enable it only for trusted HTML that you or your agent prepared.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction onClick={() => changeMode('interactive')}>
              Run scripts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingLink !== null}
        onOpenChange={(open) => {
          if (!open) setPendingLink(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add this document to the list and open it?</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              {pendingLink?.path}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingLink?.changed && (
            <p className="text-sm font-medium">
              While you were confirming, the link target changed or the confirmation expired. Check
              the path above again.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            This is the file that a link in the document points to. It is not open yet. Opening it
            adds it to the document list and to search.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>Don't open</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingLink) {
                  void openLink(pendingLink.linkId, pendingLink.revision, pendingLink.confirmation);
                }
              }}
            >
              Add to list and open
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
