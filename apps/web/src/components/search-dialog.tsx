import type { SearchHit, SearchResult } from '@vde-open/shared';
import { Search } from 'lucide-react';
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
      <DialogContent className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>Search open documents</DialogTitle>
          <DialogDescription>
            Only documents that are currently open are searched. Closed documents and other files
            are not.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b pr-10 pl-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            aria-label="Search query"
            aria-controls={listId}
            aria-activedescendant={hits.length > 0 ? `${listId}-${String(active)}` : undefined}
            placeholder="Search open documents"
            className="h-11 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="flex max-h-[min(24rem,60svh)] flex-col overflow-y-auto p-1.5 empty:hidden"
        >
          {hits.map((hit, index) => {
            // The first heading is usually the title itself.
            const path =
              hit.headingPath[0] === hit.title ? hit.headingPath.slice(1) : hit.headingPath;
            return (
              <div
                key={`${hit.documentId}:${hit.sectionId}`}
                id={`${listId}-${String(index)}`}
                role="option"
                aria-selected={index === active}
                className="cursor-pointer rounded-md px-2.5 py-1.5 aria-selected:bg-selection"
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
                <div className="flex items-baseline gap-3">
                  <p className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-medium">{hit.title}</span>
                    {path.length > 0 && (
                      <span className="text-muted-foreground"> › {path.join(' › ')}</span>
                    )}
                  </p>
                  {hit.displayPath && (
                    <p className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
                      {hit.displayPath}
                    </p>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{hit.excerpt}</p>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 border-t bg-chrome px-3 py-1.5 text-xs text-muted-foreground">
          <p role="status" aria-live="polite" className="min-w-0">
            {trimmed === ''
              ? 'Searches open documents only'
              : shown === null
                ? 'Searching…'
                : shown.error !== null
                  ? `Search failed (${shown.error})`
                  : `${String(hits.length)} ${hits.length === 1 ? 'result' : 'results'}${
                      shown.result?.incomplete === true
                        ? ', some documents are still being indexed'
                        : ''
                    }`}
          </p>
          <p className="hidden shrink-0 gap-3 sm:flex" aria-hidden="true">
            <span>
              <kbd className="font-sans">↑↓</kbd> Select
            </span>
            <span>
              <kbd className="font-sans">↵</kbd> Open
            </span>
            <span>
              <kbd className="font-sans">Esc</kbd> Close
            </span>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
