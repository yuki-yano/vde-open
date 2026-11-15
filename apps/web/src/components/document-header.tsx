import type { DocumentSummary } from '@vde-open/shared';
import { Hash } from 'lucide-react';
import type { ReactNode } from 'react';

import { CopyButton } from '@/components/copy-button';
import { DocumentLocation, DocumentPathCopyButton } from '@/components/document-location';
import { FormatIcon } from '@/components/format-icon';

// The top row of a document view: the title, where the document is, and the view's controls.
// The list shortens the location; here it wraps instead, so the whole of it can be read on touch devices too.
export function DocumentHeader({
  document,
  children,
}: {
  document: DocumentSummary;
  children: ReactNode;
}) {
  return (
    <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-chrome px-3 py-1">
      <div className="flex min-w-0 flex-1 basis-56 items-start gap-2">
        <FormatIcon format={document.format} className="mt-px" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{document.title}</h1>
          <div className="flex items-start gap-1">
            <p
              className="min-w-0 text-xs [overflow-wrap:anywhere] text-muted-foreground"
              title={document.canonicalPath ?? undefined}
              data-testid="document-location"
            >
              <DocumentLocation document={document} />
            </p>
            {/* Taller than the line; the negative margin keeps the row height of the text. */}
            <span className="-my-1 flex shrink-0">
              <DocumentPathCopyButton document={document} />
              <CopyButton
                label="document ID"
                text={document.documentId}
                icon={Hash}
                title={`Copy document ID (${document.documentId})`}
              />
            </span>
          </div>
        </div>
      </div>
      {/* Moves to its own line when the title needs the room, and wraps there in a narrow pane. */}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-0.5">
        {children}
      </div>
    </header>
  );
}

// Separates groups of controls in a toolbar.
export function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />;
}
