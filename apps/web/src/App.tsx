import type { DocumentSummary, ServerEvent } from '@vde-open/shared';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import { DocumentWorkspace } from '@/components/document-workspace';
import { Sidebar } from '@/components/sidebar';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { createApi, establishSession, forgetSession, type Api } from '@/lib/api';
import {
  isSidebarView,
  isTheme,
  usePreference,
  type SidebarView,
  type Theme,
} from '@/lib/preferences';
import { createRefresher } from '@/lib/refresher';

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 260;
const isWidth = (value: unknown): value is number =>
  typeof value === 'number' && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX;

function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = usePreference<Theme>('theme', 'system', isTheme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      window.document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}

export function Workspace({ api }: { api: Api }) {
  // 一覧と、その一覧を取得した時点のcatalogVersion。並べ替えの保存で前提として渡す。
  const [catalog, setCatalog] = useState<{ documents: DocumentSummary[]; version: number }>({
    documents: [],
    version: 0,
  });
  // 表示中の文書。initializedは、daemonが覚えている文書を初回に選び終えたか。
  const [selection, setSelection] = useState<{ activeId: string | null; initialized: boolean }>({
    activeId: null,
    initialized: false,
  });
  const { documents } = catalog;
  const { activeId } = selection;
  const setActiveId = useCallback((documentId: string) => {
    setSelection((current) => ({ ...current, activeId: documentId }));
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = usePreference<SidebarView>('sidebar-view', 'flat', isSidebarView);
  const [width, setWidth] = usePreference<number>('sidebar-width', SIDEBAR_DEFAULT, isWidth);
  const [theme, setTheme] = useTheme();
  const lastEvent = useRef<{ daemonId: string; sequence: number } | null>(null);
  // 質問の変更の通知を受け取った回数。回答panelは、これが変わるたびに質問を取り直す。
  const [feedbackSignal, setFeedbackSignal] = useState(0);

  // 一覧をdaemonから取り直す。表示中の文書は、閉じられた場合だけ切り替える。
  const fetchList = useCallback(async () => {
    const [list, status] = await Promise.all([api.documents(), api.status()]);
    setCatalog({ documents: list.documents, version: list.catalogVersion });
    setSelection((current) => {
      const stillOpen =
        current.activeId !== null &&
        list.documents.some((document) => document.documentId === current.activeId);
      if (stillOpen) return current.initialized ? current : { ...current, initialized: true };
      // 初回だけ、daemonが覚えている文書を選ぶ。
      const preferred = current.initialized ? null : status.activeDocumentId;
      return {
        activeId: preferred ?? list.documents[0]?.documentId ?? null,
        initialized: true,
      };
    });
  }, [api]);
  // 取得は1つずつ行う。並行させると、遅れて届いた古い一覧が新しい一覧を上書きする。
  // 失敗（接続が切れている間など）は無視し、再接続のときに取り直す。
  const load = useMemo(() => createRefresher(fetchList), [fetchList]);

  useEffect(() => {
    const onEvent = (event: ServerEvent) => {
      const previous = lastEvent.current;
      lastEvent.current = { daemonId: event.daemonId, sequence: event.sequence };
      if (event.type === 'daemon-stopping') {
        setNotice('daemonが停止しました。CLIを実行すると、もう一度開けます。');
        return;
      }
      // 明示的なfocusの指示のときだけ、表示する文書を切り替える。
      if (event.type === 'focus-requested' && event.documentId) setActiveId(event.documentId);
      // 通知は欠けることがある。どの通知でも、一覧を取り直して現在の状態へ合わせる。
      const gap =
        previous !== null &&
        (previous.daemonId !== event.daemonId || event.sequence > previous.sequence + 1);
      // 質問は、変更の通知のほか、通知が欠けたかもしれないときにも取り直す。
      if (event.type === 'feedback-changed' || event.type === 'resync-required' || gap) {
        setFeedbackSignal((value) => value + 1);
      }
      if (event.type !== 'hello' || gap) void load();
    };
    const stream = api.events({
      onEvent,
      // 接続し直した後は、切れていた間の変更を取り込むため、一覧と質問を取り直す。
      onConnect: () => {
        setNotice(null);
        setFeedbackSignal((value) => value + 1);
        void load();
      },
    });
    return () => stream.close();
  }, [api, load, setActiveId]);

  const active = useMemo(
    () => documents.find((document) => document.documentId === activeId) ?? null,
    [documents, activeId],
  );

  const reorder = (order: string[]) => {
    // 先に表示を入れ替え、保存に失敗したら取り直す。
    setCatalog((current) => ({
      ...current,
      documents: order.flatMap((documentId) =>
        current.documents.filter((document) => document.documentId === documentId),
      ),
    }));
    void api.reorder(order, catalog.version).then(load, load);
  };

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const onMove = (move: globalThis.PointerEvent) => {
      setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, move.clientX)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <p className="text-sm font-semibold">vde-open</p>
        <ToggleGroup
          value={[theme]}
          onValueChange={(value) => {
            const next: unknown = value[0];
            if (isTheme(next)) setTheme(next);
          }}
          size="sm"
          aria-label="配色"
        >
          <ToggleGroupItem value="light" aria-label="ライト">
            <Sun aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem value="dark" aria-label="ダーク">
            <Moon aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem value="system" aria-label="OSの設定に合わせる">
            <Monitor aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>
      </header>
      {notice && (
        <p role="status" className="border-b bg-muted px-4 py-2 text-sm">
          {notice}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="shrink-0 border-r" style={{ width }}>
          <Sidebar
            documents={documents}
            activeId={activeId}
            view={view}
            onViewChange={setView}
            onSelect={setActiveId}
            onClose={(documentId) => void api.close(documentId).then(load, load)}
            onReorder={reorder}
          />
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="一覧の幅を変える"
          className="w-1 shrink-0 cursor-col-resize hover:bg-border"
          onPointerDown={startResize}
        />
        {active ? (
          <DocumentWorkspace
            key={active.documentId}
            api={api}
            document={active}
            feedbackSignal={feedbackSignal}
          />
        ) : (
          <main className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            左の一覧から文書を選ぶと、ここに表示します。
          </main>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<'loading' | 'missing' | { token: string }>('loading');

  useEffect(() => {
    void establishSession().then((token) => setSession(token ? { token } : 'missing'));
  }, []);

  const api = useMemo(
    () =>
      typeof session === 'object'
        ? createApi(session.token, () => {
            forgetSession();
            setSession('missing');
          })
        : null,
    [session],
  );

  if (session === 'loading') return null;
  if (!api) {
    return (
      <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-3 p-8">
        <h1 className="text-xl font-semibold">CLIから開き直してください</h1>
        <p className="text-sm text-muted-foreground">
          この画面は、CLIが発行する一回限りのURLから開く必要があります。端末で{' '}
          <code className="rounded bg-muted px-1.5 py-0.5">vo ui</code> を実行してください。
        </p>
      </main>
    );
  }
  return <Workspace api={api} />;
}
