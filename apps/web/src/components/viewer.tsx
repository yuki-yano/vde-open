import { MarkdownView } from '@vde-open/document/react';
import type { DocumentSummary, OutlineItem } from '@vde-open/shared';
import { Pause, Play, RefreshCw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Api } from '@/lib/api';
import { isViewMode, usePreference, type ViewMode } from '@/lib/preferences';
import { useMarkdown } from '@/lib/use-markdown';

const PARSE_FAILURE: Record<string, string> = {
  timeout: '解析が2秒以内に終わらなかったため、原文を表示しています。',
  'limit-nodes': '文書の要素数が上限（100,000）を超えているため、原文を表示しています。',
  'limit-depth': '文書の入れ子が上限（64段）を超えているため、原文を表示しています。',
  'parse-error': '文書を解析できなかったため、原文を表示しています。',
};

const SOURCE_STATE: Record<string, string> = {
  missing: 'fileが見つかりません。表示しているのは、最後に読めた内容です。',
  unreadable: 'fileを読む権限がありません。表示しているのは、最後に読めた内容です。',
  error: 'fileを文書として読めません。表示しているのは、最後に読めた内容です。',
};

export interface ViewerProps {
  api: Api;
  document: DocumentSummary;
}

interface Loaded {
  revision: string;
  text: string | null;
  outline: OutlineItem[];
  error: string | null;
}

// 文書を切り替えたら作り直す（呼び出し側がkeyにdocumentIdを渡す）。
export function Viewer({ api, document }: ViewerProps) {
  const [mode, setMode] = usePreference<ViewMode>('view-mode', 'preview', isViewMode);
  // 更新を止めた時点の版。止めている間は、新しい版が来ても差し替えない。
  const [pinnedRevision, setPinnedRevision] = useState<string | null>(null);
  const paused = pinnedRevision !== null;
  const shownRevision = pinnedRevision ?? document.revision;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);

  useEffect(() => {
    if (shownRevision === null) return undefined;
    let cancelled = false;
    // 差し替えの前に読んでいた位置を覚えておく。
    savedScroll.current = scroller.current?.scrollTop ?? 0;
    void Promise.all([
      api.content(document.documentId, shownRevision),
      api.outline(document.documentId, shownRevision).catch(() => [] as OutlineItem[]),
    ]).then(
      ([content, items]) => {
        if (!cancelled)
          setLoaded({ revision: shownRevision, text: content, outline: items, error: null });
      },
      (reason: unknown) => {
        if (cancelled) return;
        setLoaded((current) => ({
          revision: shownRevision,
          text: current?.text ?? null,
          outline: current?.outline ?? [],
          error: reason instanceof Error ? reason.message : '読み込めませんでした。',
        }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, document.documentId, shownRevision]);

  // 次の版を読み込んでいる間は、直前の内容を表示し続ける。
  const text = loaded?.text ?? null;
  const outline = loaded?.outline ?? [];
  const error = loaded?.error ?? null;

  const isMarkdown = document.format === 'markdown';
  const wantsPreview = isMarkdown && mode === 'preview';
  const markdown = useMarkdown(wantsPreview ? text : null);
  const showPreview = wantsPreview && markdown.status === 'ready';

  // 内容が差し替わるたびに、読んでいた位置へ戻す。
  useLayoutEffect(() => {
    if (scroller.current && (text !== null || showPreview)) {
      scroller.current.scrollTop = savedScroll.current;
    }
  }, [text, showPreview]);

  const stale = paused && document.revision !== shownRevision;
  const jumpTo = (anchor: string) => {
    window.document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col" aria-label="文書の表示">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{document.title}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {document.displayPath ?? '（stdinから開いた文書）'}
            {shownRevision && <span title={shownRevision}>　版 {shownRevision.slice(4, 12)}</span>}
          </p>
        </div>
        <Badge variant="outline">{isMarkdown ? 'Markdown' : 'HTML'}</Badge>
        {paused && <Badge variant="secondary">更新停止中</Badge>}
        {isMarkdown && (
          <ToggleGroup
            value={[mode]}
            onValueChange={(value) => {
              const next: unknown = value[0];
              if (isViewMode(next)) setMode(next);
            }}
            size="sm"
            aria-label="表示の切り替え"
          >
            <ToggleGroupItem value="preview">プレビュー</ToggleGroupItem>
            <ToggleGroupItem value="source">原文</ToggleGroupItem>
          </ToggleGroup>
        )}
        <Button
          variant="outline"
          size="sm"
          aria-pressed={paused}
          onClick={() => setPinnedRevision(paused ? null : document.revision)}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {paused ? '更新を再開' : '更新を止める'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void api.refresh(document.documentId).catch(() => undefined)}
        >
          <RefreshCw aria-hidden="true" />
          読み直す
        </Button>
      </header>

      <div role="status" aria-live="polite" className="empty:hidden">
        {stale && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            新しい版があります。更新を止めているため、表示は止めた時点の版のままです。
          </p>
        )}
        {document.sourceState !== 'ready' && SOURCE_STATE[document.sourceState] && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            {SOURCE_STATE[document.sourceState]}
          </p>
        )}
        {!isMarkdown && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            HTMLのプレビューはまだ使えません。原文を表示しています。
          </p>
        )}
        {wantsPreview && markdown.status === 'failed' && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            {PARSE_FAILURE[markdown.reason] ?? PARSE_FAILURE['parse-error']}
          </p>
        )}
        {error && <p className="border-b bg-destructive/10 px-4 py-2 text-sm">{error}</p>}
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          ref={scroller}
          className="min-w-0 flex-1 overflow-y-auto px-6 py-5"
          data-testid="document-body"
        >
          {text === null ? (
            <p className="text-sm text-muted-foreground">読み込んでいます…</p>
          ) : showPreview ? (
            <article className="markdown-body mx-auto max-w-3xl">
              <MarkdownView document={markdown.document} />
            </article>
          ) : (
            <pre className="font-mono text-sm leading-relaxed whitespace-pre-wrap break-words">
              {text}
            </pre>
          )}
        </div>
        {outline.length > 0 && (
          <aside
            className="hidden w-60 shrink-0 overflow-y-auto border-l px-3 py-4 lg:block"
            aria-label="見出し"
          >
            <h2 className="mb-2 text-xs font-medium text-muted-foreground">見出し</h2>
            <ul className="flex flex-col gap-0.5 text-sm">
              {outline.map((item) => (
                <li
                  key={item.sectionId}
                  style={{ paddingLeft: `${String((item.level - 1) * 0.75)}rem` }}
                >
                  <button
                    type="button"
                    className="w-full truncate rounded px-2 py-1 text-left hover:bg-muted disabled:opacity-50"
                    disabled={!showPreview}
                    title={showPreview ? item.title : 'プレビュー表示のときに移動できます'}
                    onClick={() => jumpTo(item.anchor)}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </section>
  );
}
