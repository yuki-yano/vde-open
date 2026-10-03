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

// 入力が止まってから検索するまでの時間。
const SEARCH_DELAY_MS = 200;
const SEARCH_LIMIT = 20;

interface SearchDialogProps {
  api: Api;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 選んだ結果の文書と節へ移動する。
  onSelect: (hit: SearchHit) => void;
}

interface Loaded {
  query: string;
  result: SearchResult | null;
  error: string | null;
}

// 開いている文書を検索するdialog（仕様13.2）。対象が「開いている文書」だけであることを示す。
// ↑↓で結果を選び、Enterで移動する。Escapeで閉じる（focusは開く前の位置へ戻る）。
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
            error: reason instanceof Error ? reason.message : '検索できませんでした。',
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

  // 選んだ行が見えるように、結果の一覧をscrollする。
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
    // 変換中のkey（候補の選択や確定）は、入力欄へそのまま渡す。
    if (event.nativeEvent.isComposing) return;
    // 結果がまだ無い間は、選択を変えない（結果が届いたときに先頭を選んだ状態にする）。
    if (hits.length === 0) return;
    // 画面の更新より速くkeyを繰り返しても進むよう、直前の選択から数える。
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
          <DialogTitle>開いている文書を検索する</DialogTitle>
          <DialogDescription>
            検索の対象は、いま開いている文書だけです。閉じた文書やfileは探しません。
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="検索する語句"
          aria-controls={listId}
          aria-activedescendant={hits.length > 0 ? `${listId}-${String(active)}` : undefined}
          placeholder="語句やfile名"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {trimmed === ''
            ? '語句を入力すると、開いている文書から探します。↑↓で選び、Enterで移動します。'
            : shown === null
              ? '検索しています…'
              : shown.error !== null
                ? `検索できませんでした（${shown.error}）。`
                : `${String(hits.length)}件${
                    shown.result?.incomplete === true
                      ? '（検索の準備が終わっていない文書があるため、すべての文書を探した結果ではありません）'
                      : ''
                  }`}
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="検索の結果"
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
