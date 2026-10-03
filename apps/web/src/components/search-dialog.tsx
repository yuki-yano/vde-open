import type { SearchHit, SearchResult } from '@vde-open/shared';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { Api } from '@/lib/api';

// Delay after typing stops before searching.
const SEARCH_DELAY_MS = 200;
const SEARCH_LIMIT = 20;

interface SearchDialogProps {
  api: Api;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Jump to the document and section of the chosen result.
  onSelect: (hit: SearchHit) => void;
}

interface Loaded {
  query: string;
  result: SearchResult | null;
  error: string | null;
}

// The dialog for searching open documents (spec 13.2). Makes clear that only open documents are searched.
// ↑↓ selects a result, Enter jumps to it. Escape closes (focus returns to where it was before opening).
export function SearchDialog({ api, open, onOpenChange, onSelect }: SearchDialogProps) {
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const trimmed = query.trim();

  useEffect(() => {
    if (!open || trimmed === '') return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      void api.search(trimmed, SEARCH_LIMIT).then(
        (result) => {
          if (!cancelled) setLoaded({ query: trimmed, result, error: null });
        },
        (reason: unknown) => {
          if (cancelled) return;
          setLoaded({
            query: trimmed,
            result: null,
            error: reason instanceof Error ? reason.message : 'Search failed.',
          });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, open, trimmed]);

  const shown = loaded !== null && loaded.query === trimmed ? loaded : null;
  const hits = shown?.result?.hits ?? [];
  const clamp = (index: number) => Math.max(0, Math.min(index, hits.length - 1));
  const active = clamp(selected);

  // Scroll the result list so the selected row is visible.
  useEffect(() => {
    if (hits.length === 0) return;
    window.document
      .getElementById(`${listId}-${String(active)}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, hits.length, listId]);

  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onOpenChange(false);
    onSelect(hit);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keys during IME composition (choosing or committing a candidate) go to the input as they are.
    if (event.nativeEvent.isComposing) return;
    // While there are no results yet, do not change the selection (the first result is selected when results arrive).
    if (hits.length === 0) return;
    // Count from the previous selection so repeated keys advance even faster than the screen updates.
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((value) => clamp(clamp(value) + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((value) => clamp(clamp(value) - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(hits[active]);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setQuery('');
          setSelected(0);
        }
      }}
    >
      <DialogContent className="top-[15%] translate-y-0 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Search open documents</DialogTitle>
          <DialogDescription>
            Only documents that are currently open are searched. Closed documents and other files
            are not.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search query"
          aria-controls={listId}
          aria-activedescendant={hits.length > 0 ? `${listId}-${String(active)}` : undefined}
          placeholder="Words or a file name"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {trimmed === ''
            ? 'Type to search the open documents. Use ↑↓ to select and Enter to jump.'
            : shown === null
              ? 'Searching…'
              : shown.error !== null
                ? `Search failed (${shown.error}).`
                : `${String(hits.length)} ${hits.length === 1 ? 'result' : 'results'}${
                    shown.result?.incomplete === true
                      ? ' (some documents are not indexed yet, so not all documents were searched)'
                      : ''
                  }`}
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="flex max-h-80 flex-col gap-1 overflow-y-auto"
        >
          {hits.map((hit, index) => (
            <div
              key={`${hit.documentId}:${hit.sectionId}`}
              id={`${listId}-${String(index)}`}
              role="option"
              aria-selected={index === active}
              className="cursor-pointer rounded-md px-3 py-2 text-sm aria-selected:bg-muted"
              tabIndex={-1}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(hit)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  choose(hit);
                }
              }}
            >
              <p className="truncate font-medium">
                {hit.title}
                {hit.headingPath.length > 0 && (
                  <span className="font-normal text-muted-foreground">
                    {' '}
                    — {hit.headingPath.join(' › ')}
                  </span>
                )}
              </p>
              <p className="line-clamp-2 text-xs text-muted-foreground">{hit.excerpt}</p>
              {hit.displayPath && (
                <p className="truncate text-xs text-muted-foreground">{hit.displayPath}</p>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
