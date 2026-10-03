import type { DocumentSummary } from '@vde-open/shared';
import { ChevronDown, ChevronUp, FileCode, FileText, Folder, X } from 'lucide-react';
import { useState, type DragEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { SidebarView } from '@/lib/preferences';
import { buildTree, type TreeNode } from '@/lib/tree';
import { cn } from '@/lib/utils';

export interface SidebarProps {
  documents: DocumentSummary[];
  activeId: string | null;
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
  onSelect: (documentId: string) => void;
  onClose: (documentId: string) => void;
  onReorder: (order: string[]) => void;
}

const STATE_LABEL: Record<string, string> = {
  missing: 'File missing',
  unreadable: 'Unreadable',
  updating: 'Updating',
  error: 'error',
};

function DocumentIcon({ document }: { document: DocumentSummary }) {
  const Icon = document.format === 'html' ? FileCode : FileText;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function move(order: string[], from: number, to: number): string[] {
  const next = [...order];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

function DocumentRow({
  document,
  label,
  active,
  onSelect,
  onClose,
  children,
}: {
  document: DocumentSummary;
  label: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-md pr-1',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
        aria-current={active ? 'true' : undefined}
        title={document.displayPath ?? document.title}
        onClick={onSelect}
      >
        <DocumentIcon document={document} />
        <span className="truncate">{label}</span>
        {document.sourceState !== 'ready' && (
          <Badge variant="outline" className="shrink-0">
            {STATE_LABEL[document.sourceState] ?? document.sourceState}
          </Badge>
        )}
        {document.pendingRequestIds.length > 0 && (
          <Badge
            className="shrink-0"
            data-testid="pending-question"
            title="A question is awaiting your answer"
          >
            Question
          </Badge>
        )}
      </button>
      {children}
      <Button
        variant="ghost"
        size="icon-xs"
        className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        aria-label={`Remove ${document.title} from the list`}
        title="Remove from the list (the file is not deleted)"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

function Tree({
  nodes,
  depth,
  props,
}: {
  nodes: TreeNode[];
  depth: number;
  props: Pick<SidebarProps, 'activeId' | 'onSelect' | 'onClose'>;
}) {
  return (
    <ul className="flex flex-col gap-0.5" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) =>
        node.kind === 'directory' ? (
          <li key={`dir:${node.name}`} role="treeitem" aria-expanded="true">
            <div
              className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: `${String(0.5 + depth * 0.75)}rem` }}
            >
              <Folder className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{node.name}</span>
            </div>
            <Tree nodes={node.children} depth={depth + 1} props={props} />
          </li>
        ) : (
          <li
            key={node.document.documentId}
            role="treeitem"
            style={{ paddingLeft: `${String(depth * 0.75)}rem` }}
          >
            <DocumentRow
              document={node.document}
              label={node.name}
              active={node.document.documentId === props.activeId}
              onSelect={() => props.onSelect(node.document.documentId)}
              onClose={() => props.onClose(node.document.documentId)}
            />
          </li>
        ),
      )}
    </ul>
  );
}

export function Sidebar(props: SidebarProps) {
  const { documents, activeId, view, onViewChange, onSelect, onClose, onReorder } = props;
  const [dragging, setDragging] = useState<string | null>(null);
  const order = documents.map((document) => document.documentId);

  const onDrop = (event: DragEvent, targetId: string) => {
    event.preventDefault();
    if (dragging === null || dragging === targetId) return;
    onReorder(move(order, order.indexOf(dragging), order.indexOf(targetId)));
    setDragging(null);
  };

  return (
    <nav aria-label="Open documents" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-medium">Open documents ({documents.length})</h2>
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
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {documents.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            No documents are open. Run <code>vo &lt;file&gt;</code> in the CLI to show them here.
          </p>
        ) : view === 'tree' ? (
          <Tree nodes={buildTree(documents)} depth={0} props={{ activeId, onSelect, onClose }} />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {documents.map((document, index) => (
              // Reorder by drag. With the keyboard, use "Move up" / "Move down" on each row.
              // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
              <li
                key={document.documentId}
                draggable
                onDragStart={() => setDragging(document.documentId)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => onDrop(event, document.documentId)}
                className={cn(dragging === document.documentId && 'opacity-50')}
              >
                <DocumentRow
                  document={document}
                  label={document.title}
                  active={document.documentId === activeId}
                  onSelect={() => onSelect(document.documentId)}
                  onClose={() => onClose(document.documentId)}
                >
                  {/* A way to reorder without dragging. Do not show the button for a direction the item cannot move in. */}
                  {index > 0 && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                      aria-label={`Move ${document.title} up`}
                      onClick={() => onReorder(move(order, index, index - 1))}
                    >
                      <ChevronUp aria-hidden="true" />
                    </Button>
                  )}
                  {index < documents.length - 1 && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                      aria-label={`Move ${document.title} down`}
                      onClick={() => onReorder(move(order, index, index + 1))}
                    >
                      <ChevronDown aria-hidden="true" />
                    </Button>
                  )}
                </DocumentRow>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
