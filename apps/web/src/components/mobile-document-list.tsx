import type { MobileDocument } from '@vde-open/shared';
import { CircleAlert, Folder, FolderGit2, GitBranch, List, ListTree } from 'lucide-react';
import { useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { FormatIcon } from '@/components/format-icon';
import { LocationLine } from '@/components/location-line';
import { DocumentActions, DocumentDetails } from '@/components/mobile-document-actions';
import { Button } from '@/components/ui/button';
import {
  segmentedGroup,
  segmentedItem,
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group';
import type { SidebarView, Visibility } from '@/lib/preferences';
import {
  phoneEntry,
  REPOSITORY_REASON,
  shortDirectories,
  visible,
  type ListEntry,
  type ShortDirectory,
} from '@/lib/repository-labels';
import { buildTree, type TreeNode } from '@/lib/tree';
import { useLongPress } from '@/lib/use-long-press';
import { cn } from '@/lib/utils';

// The phone's list of the PC's open documents, for the list page and the drawer: flat (with the PC's second line) or
// as the PC's tree. A long press (or the context menu) offers the document's details and removing it from the PC list.

// The list page's header controls. The second line exists only in the flat layout, so its toggle does too.
export function MobileListControls({
  view,
  onViewChange,
  location,
  onLocationChange,
}: {
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
  location: Visibility;
  onLocationChange: (location: Visibility) => void;
}) {
  const item = cn(segmentedItem, 'h-8 min-w-8 px-1.5');
  return (
    <>
      {view === 'flat' && (
        <Button
          variant="ghost"
          size="icon"
          className="aria-pressed:bg-muted aria-pressed:text-foreground"
          aria-pressed={location === 'shown'}
          aria-label="Locations"
          title={
            location === 'shown' ? 'Hide where each document is' : 'Show where each document is'
          }
          onClick={() => onLocationChange(location === 'shown' ? 'hidden' : 'shown')}
        >
          <FolderGit2 aria-hidden="true" />
        </Button>
      )}
      <ToggleGroup
        value={[view]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === 'flat' || next === 'tree') onViewChange(next);
        }}
        spacing={0.5}
        className={segmentedGroup}
        aria-label="List layout"
      >
        <ToggleGroupItem value="flat" aria-label="Flat" title="Flat list" className={item}>
          <List aria-hidden="true" />
        </ToggleGroupItem>
        <ToggleGroupItem
          value="tree"
          aria-label="Tree"
          title="Group by repository"
          className={item}
        >
          <ListTree aria-hidden="true" />
        </ToggleGroupItem>
      </ToggleGroup>
    </>
  );
}

// The second line as text, read out after the title.
function locationDescription({ place, directories, fileName }: ListEntry): string {
  const path = [...directories, fileName].join('/');
  switch (place.kind) {
    case 'input':
      return place.source === 'stdin' ? 'Standard input' : 'Generated';
    case 'outside':
      return path;
    case 'pending':
      return `Checking repository… ${path}`;
    case 'unresolved':
      return `${place.name} (${REPOSITORY_REASON[place.reason]}) · ${path}`;
    case 'repository': {
      const { checkout } = place;
      const worktree =
        checkout.kind === 'linked'
          ? ` · worktree ${checkout.label}`
          : checkout.kind === 'unknown'
            ? ' · unknown checkout'
            : '';
      return `${place.name}${worktree} · ${path}`;
    }
  }
}

interface Menu {
  documentId: string;
  // The view epoch of the open the menu was opened for: the same document opened again is another open.
  viewEpoch: string;
  // null while closing: the last document stays so the sheet keeps its content as it leaves.
  view: 'actions' | 'details' | null;
}

export function MobileDocumentList({
  documents,
  view,
  location,
  current,
  onOpen,
  onRemove,
}: {
  documents: MobileDocument[];
  view: SidebarView;
  location: Visibility;
  current: string | null;
  onOpen: (documentId: string) => void;
  onRemove: (documentId: string) => void;
}) {
  const entries = useMemo(() => documents.map(phoneEntry), [documents]);
  const short = useMemo(() => shortDirectories(entries), [entries]);
  const tree = useMemo(() => (view === 'tree' ? buildTree(entries) : []), [entries, view]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const list = useRef<HTMLElement>(null);
  const openOf = (viewEpoch: string) => viewEpoch.split('.')[0];
  const target =
    documents.find(
      (document) =>
        menu !== null &&
        document.documentId === menu.documentId &&
        openOf(document.viewEpoch) === openOf(menu.viewEpoch),
    ) ?? null;
  // A menu for a document closed on the PC goes with it, and does not come back for the document opened again.
  if (menu !== null && target === null) setMenu(null);
  const close = () => setMenu((shown) => shown && { ...shown, view: null });
  // Focus goes back to the row the menu was opened for, not to the sheet's buttons that are gone.
  const returnFocus = () =>
    list.current?.querySelector<HTMLElement>(
      `[data-document-id="${CSS.escape(menu?.documentId ?? '')}"]`,
    ) ?? true;

  const row: RowOf = (document, children, options = {}) => (
    <Row
      document={document}
      current={document.documentId === current}
      {...options}
      onOpen={() => onOpen(document.documentId)}
      onMenu={() =>
        setMenu({ documentId: document.documentId, viewEpoch: document.viewEpoch, view: 'actions' })
      }
    >
      {children}
    </Row>
  );

  return (
    <nav ref={list} aria-label="Open documents" className="@container/list">
      {view === 'tree' ? (
        <TreeRows nodes={tree} depth={0} row={row} />
      ) : (
        <ul>
          {entries.map((entry) => (
            <FlatRow
              key={entry.document.documentId}
              entry={entry}
              location={location}
              short={short.get(entry.document.documentId)}
              row={row}
            />
          ))}
        </ul>
      )}
      <DocumentActions
        document={target}
        open={menu?.view === 'actions' && target !== null}
        onClose={close}
        onDetails={() => setMenu((shown) => shown && { ...shown, view: 'details' })}
        onRemove={() => {
          close();
          if (target) onRemove(target.documentId);
        }}
        // The sheet finishes leaving after the details opened: focus stays in the details then.
        finalFocus={() => (menu?.view === 'details' ? false : returnFocus())}
      />
      <DocumentDetails
        document={target}
        open={menu?.view === 'details' && target !== null}
        onClose={close}
        finalFocus={returnFocus}
      />
    </nav>
  );
}

interface RowOptions {
  style?: CSSProperties;
  describedBy?: string;
}
type RowOf = (document: MobileDocument, children: ReactNode, options?: RowOptions) => ReactNode;

function Row({
  document,
  current,
  style,
  describedBy,
  onOpen,
  onMenu,
  children,
}: RowOptions & {
  document: MobileDocument;
  current: boolean;
  onOpen: () => void;
  onMenu: () => void;
  children: ReactNode;
}) {
  const press = useLongPress(onMenu);
  return (
    <button
      type="button"
      // No text selection or callout on a long press: it opens the document's menu instead.
      className="flex min-h-12 w-full flex-col justify-center gap-0.5 px-4 py-2 text-left select-none [-webkit-touch-callout:none] active:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
      style={style}
      aria-current={current ? 'page' : undefined}
      aria-describedby={describedBy}
      data-document-id={document.documentId}
      onClick={onOpen}
      {...press}
    >
      {children}
    </button>
  );
}

function FlatRow({
  entry,
  location,
  short,
  row,
}: {
  entry: ListEntry<MobileDocument>;
  location: Visibility;
  short: ShortDirectory | undefined;
  row: RowOf;
}) {
  const descriptionId = useId();
  const { document } = entry;
  return (
    <li className="border-b">
      {row(
        document,
        <>
          <span className="flex w-full min-w-0 items-center gap-3">
            <FormatIcon format={document.format} />
            <span className="min-w-0 flex-1 break-words" data-part="title">
              {document.title}
            </span>
          </span>
          {location === 'shown' && (
            <>
              {/* Read out through the description below, not as part of the name. */}
              <span
                className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden pl-7 text-xs font-normal text-muted-foreground"
                aria-hidden="true"
                data-part="location"
              >
                <LocationLine entry={entry} short={short} />
              </span>
              <span id={descriptionId} hidden>
                {visible(locationDescription(entry))}
              </span>
            </>
          )}
        </>,
        location === 'shown' ? { describedBy: descriptionId } : {},
      )}
    </li>
  );
}

// The PC's tree, always expanded. Rows show the file name, as on the PC.
function TreeRows({
  nodes,
  depth,
  row,
}: {
  nodes: TreeNode<MobileDocument>[];
  depth: number;
  row: RowOf;
}) {
  const indent = (level: number): CSSProperties => ({
    paddingLeft: `${String(1 + level * 0.75)}rem`,
  });
  const header = 'flex min-h-8 items-center gap-2 pr-4 text-xs text-muted-foreground';
  return (
    <ul>
      {nodes.map((node) => {
        switch (node.kind) {
          case 'document':
            return (
              <li key={node.key} className="border-b">
                {row(
                  node.document,
                  <span className="flex w-full min-w-0 items-center gap-3">
                    <FormatIcon format={node.document.format} />
                    <bdi className="min-w-0 flex-1 break-words">{visible(node.name)}</bdi>
                  </span>,
                  { style: indent(depth) },
                )}
              </li>
            );
          case 'repository': {
            const reason = node.reason === null ? null : REPOSITORY_REASON[node.reason];
            return (
              <li key={node.key} data-node="repository">
                <div className={cn(header, 'font-medium text-foreground')} style={indent(depth)}>
                  {reason === null ? (
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
                      <span className="sr-only">worktree</span>
                      <bdi className="truncate">{visible(node.merged)}</bdi>
                    </span>
                  )}
                  {reason !== null && <span className="sr-only">{reason}</span>}
                </div>
                <TreeRows nodes={node.children} depth={depth + 1} row={row} />
              </li>
            );
          }
          case 'worktree':
            return (
              <li key={node.key} data-node="worktree">
                {/* When the repository row shows this worktree, its own row is only for screen readers. */}
                <div className={node.hidden ? 'sr-only' : header} style={indent(depth)}>
                  <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="sr-only">worktree</span>
                  <bdi className="truncate">{visible(node.name)}</bdi>
                </div>
                <TreeRows nodes={node.children} depth={node.hidden ? depth : depth + 1} row={row} />
              </li>
            );
          case 'group':
          case 'directory':
            return (
              <li key={node.key}>
                <div className={header} style={indent(depth)}>
                  <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                  <bdi className="truncate">{visible(node.name)}</bdi>
                </div>
                <TreeRows nodes={node.children} depth={depth + 1} row={row} />
              </li>
            );
          default:
            return null;
        }
      })}
    </ul>
  );
}
