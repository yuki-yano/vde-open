import { PointerActivationConstraints } from '@dnd-kit/dom';
import {
  DragDropProvider,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDragDropManager,
  useDragOperation,
} from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import type { DocumentSummary } from '@vde-open/shared';
import {
  CircleAlert,
  FileLock,
  FileX,
  Folder,
  FolderGit2,
  GitBranch,
  MessageCircleQuestionMark,
  RefreshCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';

import { DetailsPopover } from '@/components/details-popover';
import { FormatIcon } from '@/components/format-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { SidebarView } from '@/lib/preferences';
import {
  buildLabels,
  fileNameOf,
  FORMAT_LABEL,
  locationText,
  placementOf,
  REPOSITORY_REASON,
  shortDirectories,
  splitFileName,
  visible,
  type Labels,
  type ShortDirectory,
} from '@/lib/repository-labels';
import { buildTree, type TreeNode } from '@/lib/tree';
import { cn } from '@/lib/utils';

export interface SidebarProps {
  documents: DocumentSummary[];
  // The names computed from the list by the caller (computed here when not given).
  labels?: Labels;
  activeId: string | null;
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
  onSelect: (documentId: string) => void;
  onClose: (documentId: string) => void;
  onReorder: (order: string[]) => void;
}

const STATE_LABEL: Record<string, { label: string; icon: LucideIcon }> = {
  missing: { label: 'File missing', icon: FileX },
  unreadable: { label: 'Unreadable', icon: FileLock },
  updating: { label: 'Updating', icon: RefreshCw },
  error: { label: 'error', icon: CircleAlert },
};

// Badges show their text when the list is wide enough. They shrink to an icon on narrow lists (under 13rem, the same
// width), and while the row shows its remove button, so the title keeps room.
// The text stays for screen readers.
const BADGE_COMPACT = 'px-0.5 @min-[13rem]/list:px-2 @min-[13rem]/list:row-open:px-0.5';
const BADGE_ICON = '@min-[13rem]/list:hidden @min-[13rem]/list:row-open:inline';
const BADGE_TEXT = 'sr-only @min-[13rem]/list:not-sr-only @min-[13rem]/list:row-open:sr-only';
// Always an icon (the text stays for screen readers).
const BADGE_ALWAYS_COMPACT = { badge: 'px-0.5', icon: '', text: 'sr-only' };

function StatusBadges({ document }: { document: DocumentSummary }) {
  const state = document.sourceState === 'ready' ? null : STATE_LABEL[document.sourceState];
  const StateIcon = state?.icon ?? CircleAlert;
  // With a question as well, the state badge stays an icon so the title keeps room. The question keeps its text.
  const stateStyle =
    document.pendingRequestIds.length > 0
      ? BADGE_ALWAYS_COMPACT
      : { badge: BADGE_COMPACT, icon: BADGE_ICON, text: BADGE_TEXT };
  return (
    <>
      {document.sourceState !== 'ready' && (
        <Badge
          variant="outline"
          className={cn('shrink-0', stateStyle.badge)}
          title={state?.label ?? document.sourceState}
        >
          <StateIcon className={stateStyle.icon} aria-hidden="true" />
          <span className={stateStyle.text}>{state?.label ?? document.sourceState}</span>
        </Badge>
      )}
      {document.pendingRequestIds.length > 0 && (
        <Badge
          className={cn('shrink-0', BADGE_COMPACT)}
          data-testid="pending-question"
          title="A question is awaiting your answer"
        >
          <MessageCircleQuestionMark className={BADGE_ICON} aria-hidden="true" />
          <span className={BADGE_TEXT}>Question</span>
        </Badge>
      )}
    </>
  );
}

function move(order: string[], from: number, to: number): string[] {
  const next = [...order];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

// What is read out after the title: where the document is, its format, and why its repository is unknown.
function descriptionOf(document: DocumentSummary, labels: Labels): string {
  const placement = placementOf(document);
  const parts = [visible(locationText(document, labels)), FORMAT_LABEL[document.format]];
  if (placement.kind === 'unresolved') parts.push(REPOSITORY_REASON[placement.repository.reason]);
  return parts.join('. ');
}

function tooltipOf(document: DocumentSummary, labels: Labels, movable = false): string {
  const lines = [document.title, visible(locationText(document, labels))];
  if (document.canonicalPath !== null) lines.push(document.canonicalPath);
  if (movable) {
    lines.push('Drag to reorder. Space picks up, ↑↓ moves, Space drops, Escape cancels.');
    lines.push('Alt+↑ / Alt+↓ moves it in the list');
  }
  return [...new Set(lines)].join('\n');
}

// The second line of a flat row: repository, worktree, then the path within the checkout.
// Only the nearest directory is shown (more where two documents would look the same).
// When the line is too narrow, the worktree name shrinks first, then the directory, then the file name.
// The repository name (up to 60% of the line) and the extension never shrink.
// Flex shares shrinking by weight, so the weights differ by orders of magnitude: a part shrinks
// by a negligible fraction (well under a pixel) until the parts before it are gone.
function LocationLine({
  document,
  labels,
  short,
}: {
  document: DocumentSummary;
  labels: Labels;
  short: ShortDirectory | undefined;
}) {
  const placement = placementOf(document);
  if (placement.kind === 'input') {
    return (
      <span className="truncate">
        {document.sourceKind === 'stdin' ? 'Standard input' : 'Generated'} ·{' '}
        {FORMAT_LABEL[document.format]}
      </span>
    );
  }
  const { stem, extension } = splitFileName(visible(fileNameOf(document)));
  const directory =
    short === undefined || short.shown.length === 0
      ? ''
      : `${short.elided ? '…/' : ''}${short.shown.map(visible).join('/')}/`;
  const path = (
    <span className="flex min-w-0 shrink">
      {/* At least wide enough for the ellipsis, so a squeezed directory never shows a stray letter. */}
      {directory !== '' && <span className="min-w-3 shrink-[100000] truncate">{directory}</span>}
      <span className="min-w-0 shrink truncate">{stem}</span>
      <span className="shrink-0" data-part="extension">
        {extension}
      </span>
    </span>
  );
  if (placement.kind === 'outside') return path;
  if (placement.kind === 'pending') {
    return (
      <>
        <span className="shrink-0">Checking repository…</span>
        {path}
      </>
    );
  }
  const name = visible(labels.repository.get(placement.key) ?? '');
  const checkout = placement.kind === 'repository' ? placement.repository.checkout : undefined;
  return (
    <>
      <span
        className="flex max-w-[50%] shrink-0 items-center gap-1 font-medium @min-[13rem]/list:max-w-[60%]"
        data-part="repository"
      >
        {placement.kind === 'unresolved' && (
          <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
        )}
        <bdi className="min-w-0 truncate" data-part="repository-name">
          {name}
        </bdi>
      </span>
      {checkout?.kind === 'linked' && (
        // The branch icon stays whole even when the name has no room left.
        <span
          className="flex min-w-3 shrink-[100000] items-center gap-0.5 overflow-hidden"
          data-part="worktree"
        >
          <GitBranch className="size-3 shrink-0" aria-hidden="true" />
          <bdi className="min-w-0 truncate">
            {visible(labels.worktree.get(checkout.id) ?? checkout.name)}
          </bdi>
        </span>
      )}
      {checkout === null && (
        <span className="min-w-0 shrink-[100000] truncate">(unknown checkout)</span>
      )}
      {path}
    </>
  );
}

// Rows off screen skip style and layout until they scroll into view (the list can hold 2,000 documents).
// Their content stays in the accessibility tree and in find-in-page. Painting is clipped to the row,
// so the focus ring of the row button is drawn inside it.
const OFFSCREEN_ROW = '[content-visibility:auto]';
const ROW_FOCUS =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

const ROW_SENSORS = [
  PointerSensor.configure({
    // Pointer dragging uses the entire row, including its document button.
    activatorElements: (source) => [source.element],
    preventActivation: (event, source) =>
      source.data['canReorder'] !== true ||
      (event.target instanceof Element && event.target.closest('[data-row-action]') !== null),
    activationConstraints: (event) =>
      event.pointerType === 'touch'
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 8 })],
  }),
  KeyboardSensor.configure({
    // Enter opens the document; Space starts keyboard sorting on its row button.
    keyboardCodes: { ...KeyboardSensor.defaults.keyboardCodes, start: ['Space'] },
    preventActivation: (event, source) =>
      source.data['canReorder'] !== true || event.target !== source.handle,
  }),
];

function FlatRow({
  document,
  index,
  count,
  labels,
  short,
  active,
  pressedOn,
  onSelect,
  onClose,
  onMove,
}: {
  document: DocumentSummary;
  index: number;
  count: number;
  labels: Labels;
  short: ShortDirectory | undefined;
  active: boolean;
  // The button the last press in the list started on.
  pressedOn: RefObject<Element | null>;
  onSelect: () => void;
  onClose: () => void;
  onMove: (to: number) => void;
}) {
  const descriptionId = useId();
  const canMoveUp = index > 0;
  const canMoveDown = index < count - 1;
  const { ref, handleRef, isDragSource } = useSortable({
    id: document.documentId,
    index,
    // Keep the document button enabled when there is only one item.
    disabled: { droppable: count < 2 },
    data: { canReorder: count > 1 },
    sensors: ROW_SENSORS,
    transition: { duration: 180, easing: 'ease-out' },
  });
  // Alt+Up / Alt+Down remains available on the document button.
  const onKeyDown = (event: KeyboardEvent) => {
    if (isDragSource) return;
    if (!event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'ArrowUp' && canMoveUp) {
      event.preventDefault();
      onMove(index - 1);
    } else if (event.key === 'ArrowDown' && canMoveDown) {
      event.preventDefault();
      onMove(index + 1);
    }
  };
  const hoverButton = 'opacity-0 row-open:opacity-100';
  // A click from a pointer counts only if the press started on the same button. On a touch screen with hover,
  // a tap can reveal a button between the press and the click; that click is dropped. Keyboard clicks always count.
  const pressed = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 0 && pressedOn.current !== event.currentTarget) return;
    action();
  };

  return (
    <li
      ref={ref}
      data-drag-source={isDragSource || undefined}
      className={cn(
        'group/row relative rounded-md [contain-intrinsic-size:auto_3.125rem]',
        OFFSCREEN_ROW,
        count > 1 && 'cursor-grab active:cursor-grabbing',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
        isDragSource &&
          'bg-primary/10 outline-2 -outline-offset-2 outline-dashed outline-primary [&>button]:opacity-0 [&>span]:opacity-0',
      )}
    >
      {isDragSource && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-medium text-primary"
          data-testid="drop-position"
        >
          Drop here
        </div>
      )}
      <button
        ref={handleRef}
        type="button"
        className={cn(
          'group/button flex w-full min-w-0 flex-col gap-0.5 rounded-md py-1.5 pr-2 pl-2 text-left text-sm',
          count > 1 && 'cursor-grab active:cursor-grabbing',
          ROW_FOCUS,
        )}
        aria-current={active ? 'true' : undefined}
        aria-describedby={descriptionId}
        aria-keyshortcuts={count > 1 ? 'Alt+ArrowUp Alt+ArrowDown Space' : undefined}
        title={tooltipOf(document, labels, count > 1)}
        data-document-id={document.documentId}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5 row-open:pr-6">
          <FormatIcon format={document.format} />
          <span className="min-w-12 flex-1 truncate" data-part="title">
            {document.title}
          </span>
          <StatusBadges document={document} />
        </span>
        {/* The second line is read out through the description below, not as part of the name. */}
        <span
          className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden pl-6 text-xs text-muted-foreground group-focus-visible/button:hidden"
          aria-hidden="true"
          data-part="location"
        >
          <LocationLine document={document} labels={labels} short={short} />
        </span>
        {/* With keyboard focus the whole location shows, wrapped, since the row cannot show a tooltip. */}
        <span
          className="hidden pl-6 text-xs break-all text-muted-foreground group-focus-visible/button:block"
          aria-hidden="true"
          data-part="location-full"
        >
          {visible(locationText(document, labels))}
        </span>
      </button>
      {/* Hidden from view and from the names around it; aria-describedby still reads it. */}
      <span id={descriptionId} hidden>
        {descriptionOf(document, labels)}
      </span>
      {/* Invisible buttons take no clicks: a tap on a badge under them must not remove the document. */}
      <span className="pointer-events-none absolute top-1 right-1 flex items-center gap-0.5 row-open:pointer-events-auto">
        <Button
          variant="ghost"
          size="icon-xs"
          className={hoverButton}
          aria-label={`Remove ${document.title} from the list`}
          title="Remove from the list (the file is not deleted)"
          data-row-action="remove"
          onClick={pressed(onClose)}
        >
          <X aria-hidden="true" />
        </Button>
      </span>
    </li>
  );
}

function TreeDocumentRow({
  document,
  name,
  labels,
  active,
  depth,
  onSelect,
  onClose,
}: {
  document: DocumentSummary;
  name: string;
  labels: Labels;
  active: boolean;
  depth: number;
  onSelect: () => void;
  onClose: () => void;
}) {
  const descriptionId = useId();
  return (
    <li
      role="treeitem"
      className={cn('[contain-intrinsic-size:auto_2.25rem]', OFFSCREEN_ROW)}
      style={{ paddingLeft: `${String(depth * 0.75)}rem` }}
    >
      <div
        className={cn(
          'group/row flex items-center gap-1 rounded-md pr-1',
          active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
        )}
      >
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
            ROW_FOCUS,
          )}
          aria-current={active ? 'true' : undefined}
          aria-describedby={descriptionId}
          title={tooltipOf(document, labels)}
          data-document-id={document.documentId}
          onClick={onSelect}
        >
          <FormatIcon format={document.format} />
          <bdi className="min-w-12 flex-1 truncate">{visible(name)}</bdi>
          <StatusBadges document={document} />
        </button>
        <span id={descriptionId} hidden>
          {descriptionOf(document, labels)}
        </span>
        {/* Unlike a flat row, this button has its own place beside the row and covers nothing,
            so a tap cannot reveal it under the finger and it needs no press check. */}
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 row-open:opacity-100"
          aria-label={`Remove ${document.title} from the list`}
          title="Remove from the list (the file is not deleted)"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

// Rows of repositories and worktrees stay at the top while their documents scroll by (two rows of h-7).
const STICKY_ROW = 'sticky flex h-7 items-center gap-2 bg-background px-2 text-xs';

function Tree({
  nodes,
  depth,
  labels,
  props,
}: {
  nodes: TreeNode[];
  depth: number;
  labels: Labels;
  props: Pick<SidebarProps, 'activeId' | 'onSelect' | 'onClose'>;
}) {
  const indent = (level: number) => ({ paddingLeft: `${String(0.5 + level * 0.75)}rem` });
  return (
    <ul className="flex flex-col gap-0.5" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) => {
        switch (node.kind) {
          case 'document':
            return (
              <TreeDocumentRow
                key={node.key}
                document={node.document}
                name={node.name}
                labels={labels}
                active={node.document.documentId === props.activeId}
                depth={depth}
                onSelect={() => props.onSelect(node.document.documentId)}
                onClose={() => props.onClose(node.document.documentId)}
              />
            );
          case 'repository': {
            const label =
              node.merged === null ? node.name : `${node.name}, worktree ${node.merged}`;
            const reason = node.reason === null ? null : REPOSITORY_REASON[node.reason];
            return (
              <li
                key={node.key}
                role="treeitem"
                aria-expanded="true"
                aria-label={visible(label)}
                data-node="repository"
              >
                <div
                  className={cn(STICKY_ROW, 'top-0 z-20 font-medium')}
                  style={indent(depth)}
                  title={[node.location, reason].filter(Boolean).join('\n')}
                >
                  {node.reason === null ? (
                    <FolderGit2
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <CircleAlert
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <bdi className="max-w-[60%] shrink-0 truncate">{visible(node.name)}</bdi>
                  {node.merged !== null && (
                    <span className="flex min-w-0 items-center gap-1 font-normal text-muted-foreground">
                      <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                      <bdi className="truncate">{visible(node.merged)}</bdi>
                    </span>
                  )}
                  {reason !== null && <span className="sr-only">{reason}</span>}
                </div>
                <Tree nodes={node.children} depth={depth + 1} labels={labels} props={props} />
              </li>
            );
          }
          case 'worktree':
            return (
              <li
                key={node.key}
                role="treeitem"
                aria-expanded="true"
                aria-label={`Worktree ${visible(node.name)}`}
                data-node="worktree"
              >
                {/* When the repository row shows this worktree, its own row is hidden but kept for screen readers. */}
                <div
                  className={node.hidden ? 'sr-only' : cn(STICKY_ROW, 'top-7 z-10')}
                  style={node.hidden ? undefined : indent(depth)}
                  title={node.location}
                >
                  <GitBranch
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <bdi className="truncate">{visible(node.name)}</bdi>
                </div>
                <Tree
                  nodes={node.children}
                  depth={node.hidden ? depth : depth + 1}
                  labels={labels}
                  props={props}
                />
              </li>
            );
          case 'group':
          case 'directory':
            return (
              <li
                key={node.key}
                role="treeitem"
                aria-expanded="true"
                aria-label={visible(node.name)}
              >
                <div
                  className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
                  style={indent(depth)}
                >
                  <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                  <bdi className="truncate">{visible(node.name)}</bdi>
                </div>
                <Tree nodes={node.children} depth={depth + 1} labels={labels} props={props} />
              </li>
            );
          default:
            return null;
        }
      })}
    </ul>
  );
}

function isVisibleIn(list: HTMLElement, row: Element): boolean {
  const area = list.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  return box.bottom > area.top && box.top < area.bottom;
}

function rowIn(list: HTMLElement, documentId: string): HTMLElement | null {
  return list.querySelector<HTMLElement>(`[data-document-id="${CSS.escape(documentId)}"]`);
}

// Keeps keyboard focus and the position of the focused row across list updates (they arrive on every change).
// Focus moves back only when an update re-created the focused row, without scrolling for it.
// The list scrolls only when the focused row was visible and an update pushed it out; a list the user scrolled
// away from the focused row stays where it is.
function useKeepFocus(container: RefObject<HTMLDivElement | null>) {
  const focused = useRef<{ documentId: string; visible: boolean } | null>(null);

  useEffect(() => {
    const list = container.current;
    if (!list) return;
    const onFocusIn = (event: FocusEvent) => {
      const row = (event.target as Element)
        .closest('li')
        ?.querySelector<HTMLElement>('[data-document-id]');
      const documentId = row?.dataset['documentId'];
      focused.current =
        row && documentId !== undefined ? { documentId, visible: isVisibleIn(list, row) } : null;
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = event.target as Element;
      // Wait until focus settles. A row removed by an update keeps the record; leaving the list clears it.
      setTimeout(() => {
        if (!target.isConnected) return;
        if (!list.contains(globalThis.document.activeElement)) focused.current = null;
      }, 0);
    };
    const onScroll = () => {
      const current = focused.current;
      if (!current) return;
      const row = rowIn(list, current.documentId);
      current.visible = row !== null && isVisibleIn(list, row);
    };
    list.addEventListener('focusin', onFocusIn);
    list.addEventListener('focusout', onFocusOut);
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      list.removeEventListener('focusin', onFocusIn);
      list.removeEventListener('focusout', onFocusOut);
      list.removeEventListener('scroll', onScroll);
    };
  }, [container]);

  // After every render: an update may have re-created or moved the focused row.
  useLayoutEffect(() => {
    const list = container.current;
    const current = focused.current;
    if (!list || !current) return;
    const row = rowIn(list, current.documentId);
    // Rows are re-created within the same commit, so a missing row means the document was closed.
    // Forget it, or reopening it later would pull focus and the scroll position back to it.
    if (!row) {
      focused.current = null;
      return;
    }
    const activeElement = globalThis.document.activeElement;
    if (activeElement === null || activeElement === globalThis.document.body) {
      row.focus({ preventScroll: true });
    }
    if (current.visible && !isVisibleIn(list, row)) row.scrollIntoView({ block: 'nearest' });
    current.visible = isVisibleIn(list, row);
  });
}

// Keep the frozen rows until the library has restored their DOM order and finished the drop.
// Updating the catalog sooner would prevent its cancellation cleanup from restoring the rows.
function DragCatalogGuard({
  documents,
  snapshot,
  onChanged,
  onFinished,
}: {
  documents: DocumentSummary[];
  snapshot: DocumentSummary[] | null;
  onChanged: () => void;
  onFinished: () => void;
}) {
  const manager = useDragDropManager();
  const { source } = useDragOperation();
  useEffect(() => {
    if (!snapshot) return;
    if (!source) {
      onFinished();
    } else if (
      !manager?.dragOperation.controller?.signal.aborted &&
      (snapshot.length !== documents.length ||
        snapshot.some((item, index) => item.documentId !== documents[index]?.documentId))
    ) {
      onChanged();
      manager?.actions.stop({ canceled: true });
    }
  }, [documents, snapshot, source, manager, onChanged, onFinished]);
  return null;
}

export function Sidebar(props: SidebarProps) {
  const { documents, activeId, view, onViewChange, onSelect, onClose, onReorder } = props;
  const [dragDocuments, setDragDocuments] = useState<DocumentSummary[] | null>(null);
  const [reorderMessage, setReorderMessage] = useState<string | null>(null);
  const order = documents.map((document) => document.documentId);
  const given = props.labels;
  const labels = useMemo(() => given ?? buildLabels(documents), [given, documents]);
  const pressedOn = useRef<Element | null>(null);
  const shortened = useMemo(() => shortDirectories(documents), [documents]);
  const tree = useMemo(
    () => (view === 'tree' ? buildTree(documents, labels) : []),
    [documents, labels, view],
  );
  const list = useRef<HTMLDivElement>(null);
  useKeepFocus(list);

  return (
    <nav
      aria-label="Open documents"
      className="flex h-full min-h-0 flex-col"
      onPointerDownCapture={(event) => {
        pressedOn.current = (event.target as Element).closest('button');
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-medium">Open documents ({documents.length})</h2>
        {reorderMessage && (
          <DetailsPopover
            title="Order not changed"
            trigger={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Order not changed"
                className="text-destructive"
              >
                <CircleAlert aria-hidden="true" />
              </Button>
            }
          >
            <p>{reorderMessage}</p>
          </DetailsPopover>
        )}
        <span role="status" className="sr-only">
          {reorderMessage}
        </span>
        <ToggleGroup
          value={[view]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === 'flat' || next === 'tree') onViewChange(next);
          }}
          size="sm"
          aria-label="List layout"
        >
          <ToggleGroupItem value="flat">Flat</ToggleGroupItem>
          <ToggleGroupItem value="tree">Tree</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div
        ref={list}
        className={cn(
          '@container/list min-h-0 flex-1 overflow-y-auto p-2',
          // Rows that scroll into view stay below the sticky repository and worktree rows.
          view === 'tree' && 'scroll-pt-14',
        )}
      >
        {documents.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            No documents are open. Run <code>vo &lt;file&gt;</code> in the CLI to show them here.
          </p>
        ) : view === 'tree' ? (
          <Tree nodes={tree} depth={0} labels={labels} props={{ activeId, onSelect, onClose }} />
        ) : (
          <DragDropProvider
            onDragStart={() => {
              setDragDocuments(documents);
              setReorderMessage(null);
            }}
            onDragEnd={(event) => {
              if (event.canceled || !event.operation.target || !isSortable(event.operation.source))
                return;
              const source = event.operation.source;
              if (source.initialIndex === source.index) return;
              const snapshot = (dragDocuments ?? documents).map((item) => item.documentId);
              // A concurrent catalog change must not save an old list over the new one.
              if (
                snapshot.length !== order.length ||
                snapshot.some((id, index) => id !== order[index])
              ) {
                setReorderMessage(
                  'The document list changed while dragging. Drag again to reorder the current list.',
                );
                return;
              }
              onReorder(move(order, source.initialIndex, source.index));
            }}
          >
            <DragCatalogGuard
              documents={documents}
              snapshot={dragDocuments}
              onChanged={() =>
                setReorderMessage(
                  'The document list changed while dragging. Drag again to reorder the current list.',
                )
              }
              onFinished={() => setDragDocuments(null)}
            />
            <ul className="flex flex-col gap-0.5">
              {(dragDocuments ?? documents).map((document, index) => (
                <FlatRow
                  key={document.documentId}
                  document={document}
                  index={index}
                  count={(dragDocuments ?? documents).length}
                  labels={labels}
                  short={shortened.get(document.documentId)}
                  active={document.documentId === activeId}
                  pressedOn={pressedOn}
                  onSelect={() => onSelect(document.documentId)}
                  onClose={() => onClose(document.documentId)}
                  onMove={(to) => onReorder(move(order, index, to))}
                />
              ))}
            </ul>
            <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>
              {(source) => {
                const item = (dragDocuments ?? documents).find(
                  (candidate) => candidate.documentId === source.id,
                );
                return item ? (
                  <div
                    aria-hidden="true"
                    data-testid="drag-card"
                    className="rounded-md border border-primary bg-background p-3 text-sm shadow-lg"
                  >
                    <p className="flex items-center gap-2 font-medium">
                      <FormatIcon format={item.format} />
                      {item.title}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {visible(locationText(item, labels))}
                    </p>
                  </div>
                ) : null;
              }}
            </DragOverlay>
          </DragDropProvider>
        )}
      </div>
    </nav>
  );
}
