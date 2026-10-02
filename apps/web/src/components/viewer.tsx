import { classifyReference, dirnameOfLogicalPath, encodeLogicalPath } from '@vde-open/document';
import { MarkdownView } from '@vde-open/document/react';
import type { DocumentSummary, OutlineItem } from '@vde-open/shared';
import { Pause, Play, RefreshCw } from 'lucide-react';
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
import { isViewMode, usePreference, type ViewMode } from '@/lib/preferences';
import { useMarkdown } from '@/lib/use-markdown';
import { useRenderGrant } from '@/lib/use-render-grant';

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

// 未登録の文書を開く前の確認。pathは、daemonが解決した絶対path。
// 確認は、確認を求められたときの版と行き先に結び付く。確定のときも、その版と識別子を送る。
interface PendingLink {
  linkId: string;
  revision: string;
  path: string;
  confirmation: string;
  // 前の確認が成立しなかった（行き先が変わった、期限が切れた）。
  changed: boolean;
}

// 文書を切り替えたら作り直す（呼び出し側がkeyにdocumentIdを渡す）。
export function Viewer({ api, document }: ViewerProps) {
  const [mode, setMode] = usePreference<ViewMode>('view-mode', 'preview', isViewMode);
  // 更新を止めた時点の版。止めている間は、新しい版が来ても差し替えない。
  const [pinnedRevision, setPinnedRevision] = useState<string | null>(null);
  const paused = pinnedRevision !== null;
  const shownRevision = pinnedRevision ?? document.revision;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
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
  const wantsPreview = mode === 'preview';
  const markdown = useMarkdown(isMarkdown && wantsPreview ? text : null);
  const grantState = useRenderGrant(api, document.documentId, shownRevision, document.updatedAt);
  const grant = grantState.status === 'ready' ? grantState.grant : null;

  const showMarkdown = isMarkdown && wantsPreview && markdown.status === 'ready';
  // HTMLは、変換した内容を、別のoriginのsandboxの中で表示する。
  const frameUrl = !isMarkdown && wantsPreview ? (grant?.documentUrl ?? null) : null;

  // 内容が差し替わるたびに、読んでいた位置へ戻す。
  useLayoutEffect(() => {
    if (scroller.current && (text !== null || showMarkdown)) {
      scroller.current.scrollTop = savedScroll.current;
    }
  }, [text, showMarkdown]);

  // Markdownの画像は、登録済みのlocal fileだけを、表示用のURLから読み込む。
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

  // localの文書へのlinkを開く。未登録の文書は、pathを示して確認してから開く。
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
        setLinkError(reason instanceof Error ? reason.message : 'linkを開けませんでした。');
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

  const stale = paused && document.revision !== shownRevision;
  const jumpTo = (anchor: string) => {
    window.document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
  };
  const diagnostics = grant?.diagnostics ?? [];
  // HTMLのlinkは表示の中では押せないので、一覧から開く。Markdownのlinkは本文から開ける。
  const links = isMarkdown ? [] : (grant?.links ?? []);

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
        {!isMarkdown && <Badge variant="outline">静的表示</Badge>}
        {paused && <Badge variant="secondary">更新停止中</Badge>}
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
        {!isMarkdown && wantsPreview && grantState.status === 'failed' && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            HTMLを表示用に変換できなかったため、原文を表示しています（{grantState.message}）
          </p>
        )}
        {isMarkdown && wantsPreview && markdown.status === 'failed' && (
          <p className="border-b bg-muted px-4 py-2 text-sm">
            {PARSE_FAILURE[markdown.reason] ?? PARSE_FAILURE['parse-error']}
          </p>
        )}
        {error && <p className="border-b bg-destructive/10 px-4 py-2 text-sm">{error}</p>}
        {linkError && <p className="border-b bg-destructive/10 px-4 py-2 text-sm">{linkError}</p>}
      </div>

      {(diagnostics.length > 0 || links.length > 0) && (
        <div className="flex flex-col border-b text-sm">
          {diagnostics.length > 0 && (
            <details className="px-4 py-2" data-testid="render-diagnostics">
              <summary className="cursor-pointer">
                元の文書と表示が異なる点（{diagnostics.length}種類）
              </summary>
              {/* 項目が多くても、文書の表示領域を押し出さない。 */}
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
              <summary className="cursor-pointer">文書中のlink（{links.length}件）</summary>
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
                      {link.kind === 'other' && '（この種類のlinkは開けません）'}
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
            {/* 枠の中は、開いた文書の内容。この製品の画面ではないことを、常に示す。 */}
            <p className="border-b bg-muted px-4 py-1 text-xs text-muted-foreground">
              ここから下は、開いた文書の内容です（静的表示。scriptは動かず、linkと送信は無効です）。
            </p>
            <iframe
              // 版ごとに作り直す。前の版の表示は残さない。
              key={frameUrl}
              title={`${document.title} の表示`}
              src={frameUrl}
              // 空のsandbox。scriptも、同じoriginとしての扱いも、送信も、popupも許可しない。
              sandbox=""
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
              <p className="text-sm text-muted-foreground">読み込んでいます…</p>
            ) : showMarkdown ? (
              <article className="markdown-body mx-auto max-w-3xl">
                <MarkdownView
                  document={markdown.document}
                  {...(resolveImage ? { resolveImage } : {})}
                  onOpenLink={openMarkdownLink}
                />
              </article>
            ) : !isMarkdown && wantsPreview && grantState.status === 'loading' ? (
              <p className="text-sm text-muted-foreground">表示を準備しています…</p>
            ) : (
              <pre className="font-mono text-sm leading-relaxed break-words whitespace-pre-wrap">
                {text}
              </pre>
            )}
          </div>
        )}
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
                    disabled={!showMarkdown}
                    title={
                      showMarkdown ? item.title : 'Markdownのプレビュー表示のときに移動できます'
                    }
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

      <AlertDialog
        open={pendingLink !== null}
        onOpenChange={(open) => {
          if (!open) setPendingLink(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>この文書を一覧に追加して開きますか</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              {pendingLink?.path}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingLink?.changed && (
            <p className="text-sm font-medium">
              確認している間に、linkの行き先が変わったか、確認の期限が切れました。上のpathをもう一度確かめてください。
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            文書中のlinkが指しているfileです。まだ開かれていません。開くと、一覧と検索の対象に加わります。
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>開かない</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingLink) {
                  void openLink(pendingLink.linkId, pendingLink.revision, pendingLink.confirmation);
                }
              }}
            >
              一覧に追加して開く
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
