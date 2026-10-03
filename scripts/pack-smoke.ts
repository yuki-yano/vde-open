// 配布tarballを空のdirectoryへ導入し、両binを検証する（仕様14.4）。
// 実装済みの手順までを実行する。手順を足すときはここへ追加する。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import {
  captureCommand,
  captureInstalledBin,
  captureInstalledBinAsync,
  cliDir,
  repoRoot,
  runNpm,
  runPnpm,
} from './lib.ts';

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

// 手順1: tarballを生成し、中身を検査する。
function packTarball(): string {
  if (!existsSync(join(cliDir, 'dist', 'cli.js'))) {
    fail('apps/cli/dist/cli.js がありません。先に pnpm build を実行してください。');
  }
  const artifactsDir = join(repoRoot, 'artifacts');
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });
  runPnpm(['pack', '--pack-destination', artifactsDir], { cwd: cliDir });
  const tarballs = readdirSync(artifactsDir).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) fail(`tarballが1つではありません: ${tarballs.join(', ')}`);
  const tarball = join(artifactsDir, tarballs[0] as string);

  const listing = captureCommand('tar', ['-tzf', tarball], { cwd: repoRoot });
  if (listing.status !== 0) fail(`tarballを読めません: ${listing.stderr}`);
  const entries = new Set(listing.stdout.split(/\r?\n/).filter(Boolean));
  for (const entry of [
    'package/package.json',
    'package/dist/cli.js',
    'package/dist/daemon.js',
    'package/dist/workers/parse-worker.js',
    'package/dist/web/index.html',
  ]) {
    if (!entries.has(entry)) fail(`tarballに ${entry} がありません`);
  }
  for (const entry of entries) {
    if (entry.startsWith('package/src/') || entry.endsWith('.ts')) {
      fail(`tarballにsourceが含まれています: ${entry}`);
    }
  }
  return tarball;
}

async function verifyInstalled(tarball: string, installDir: string): Promise<void> {
  // 手順2: 空のdirectoryへtarballだけを導入する。registryへは問い合わせない。
  writeFileSync(join(installDir, 'package.json'), '{"private":true}\n');
  runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: installDir,
  });

  // binのshebangが、いま検証に使っているNodeを起動するようにする。
  // stateは導入先の中の試験用homeに置き、通常のdaemonとstateに触れない。
  const stateHome = join(installDir, 'state home');
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env['PATH'] ?? ''}`,
    VDE_OPEN_HOME: stateHome,
  };
  const binDir = join(installDir, 'node_modules', '.bin');
  const runBin = (name: string, args: string[]): string => {
    const result = captureInstalledBin(binDir, name, args, { cwd: installDir, env });
    if (result.status !== 0) {
      fail(`${name} ${args.join(' ')} が exit ${String(result.status)}: ${result.stderr}`);
    }
    return result.stdout;
  };

  // 手順3（CLI-002）: 両名のversionとhelpが一致する。
  for (const args of [['--version'], ['--help']]) {
    const long = runBin('vde-open', args);
    const short = runBin('vo', args);
    if (long.trim() === '') fail(`vde-open ${args.join(' ')} の出力が空です`);
    if (long !== short) fail(`vde-open と vo の ${args.join(' ')} が一致しません`);
  }

  interface Envelope<T> {
    ok: boolean;
    data: T;
  }
  const runJson = <T>(name: string, args: string[]): T => {
    const envelope = JSON.parse(runBin(name, [...args, '--json'])) as Envelope<T>;
    if (!envelope.ok) fail(`${name} ${args.join(' ')} が失敗しました`);
    return envelope.data;
  };
  type Documents = { documents: Array<{ documentId: string }> };
  type Status = { state: string; daemonId: string | null };

  try {
    // 手順4（CLI-003）: 長名で開いた文書を、短名で一覧・closeできる。
    writeFileSync(join(installDir, 'a.md'), '# pack検証\n');
    const opened = runJson<Documents>('vde-open', ['open', 'a.md']);
    const listed = runJson<Documents>('vo', ['list']);
    const openedId = opened.documents[0]?.documentId;
    if (!openedId || listed.documents.map((document) => document.documentId).join() !== openedId) {
      fail('vde-openで開いた文書が、voの一覧と一致しません');
    }
    const daemonId = runJson<Status>('vo', ['daemon', 'status']).daemonId;
    if (runJson<Status>('vde-open', ['daemon', 'status']).daemonId !== daemonId) {
      fail('vde-openとvoが別のdaemonを使っています');
    }
    // 手順6: repoの外のcwdから、同梱のUIと解析workerが動く。cwdのfileは配信しない。
    const outline = runJson<{ outline: unknown[] }>('vo', ['read', openedId, '--outline']);
    if (outline.outline.length !== 1) fail('同梱の解析workerで見出しを取得できません');
    const uiUrl = runJson<{ uiUrl: string }>('vde-open', ['daemon', 'status']).uiUrl;
    const page = await fetch(uiUrl);
    const html = await page.text();
    const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (page.status !== 200 || !html.includes('id="root"') || !script) {
      fail('同梱のUIを配信できていません');
    }
    if ((await fetch(new URL(script, uiUrl))).status !== 200)
      fail('UIのscriptを配信できていません');
    if ((await fetch(new URL('a.md', uiUrl))).status !== 404)
      fail('cwdのfileがUIのoriginから配信されています');

    // 手順6の続き: 導入先だけで、検索のworker（同梱のMiniSearch）が動く。
    const found = runJson<{ hits: Array<{ documentId: string }>; incomplete: boolean }>('vo', [
      'search',
      'pack検証',
    ]);
    if (found.incomplete || found.hits[0]?.documentId !== openedId) {
      fail('同梱の検索workerで、開いた文書を検索できません');
    }

    // 手順6の続き: 導入先だけで、質問の作成と、Agent向けの取得（回答案を返さない）が動く。
    writeFileSync(
      join(installDir, 'q.json'),
      JSON.stringify({
        schemaVersion: 1,
        title: 'pack検証の質問',
        fieldOrder: ['ok'],
        answerSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean', title: '確認' } },
          required: ['ok'],
          additionalProperties: false,
        },
      }),
    );
    const asked = runJson<{ request: { requestId: string; status: string } }>('vo', [
      'ask',
      'q.json',
      '--document',
      openedId,
    ]).request;
    const got = runJson<Record<string, unknown>>('vo', ['feedback', 'get', asked.requestId]);
    if (asked.status !== 'pending' || got['status'] !== 'pending' || 'draftAnswers' in got) {
      fail('導入先で、質問を作成・取得できません');
    }
    runJson('vo', ['feedback', 'cancel', asked.requestId]);

    // 手順6の続き: 導入先だけで、HTMLの静的変換（同梱のparse5とcss-tree）と表示用のlistenerが動く。
    mkdirSync(join(installDir, 'site'));
    writeFileSync(
      join(installDir, 'site', 'site.css'),
      '.a{color:red}.b{background:url(//e/x.png)}',
    );
    writeFileSync(
      join(installDir, 'site', 'index.html'),
      '<link rel="stylesheet" href="site.css"><script>x()</script><p id="p">pack</p>',
    );
    const htmlId = runJson<Documents>('vo', ['open', 'site/index.html']).documents[0]?.documentId;
    const origin = uiUrl.replace(/\/$/, '');
    const ticket = runBin('vo', ['ui', '--print-url']).trim().split('#bootstrap=')[1] ?? '';
    const post = async <T>(path: string, body: unknown, token?: string): Promise<T> => {
      const response = await fetch(`${origin}/_/api/v1${path}`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
      const envelope = (await response.json()) as Envelope<T>;
      if (!envelope.ok) fail(`${path} が失敗しました（${String(response.status)}）`);
      return envelope.data;
    };
    const { token } = await post<{ token: string }>('/sessions/bootstrap', { ticket });
    const grant = await post<{ documentUrl: string; filesBaseUrl: string }>(
      `/documents/${htmlId ?? ''}/render-grants`,
      {},
      token,
    );
    const rendered = await (await fetch(grant.documentUrl)).text();
    if (!rendered.includes('<p id="p">pack</p>') || rendered.includes('<script')) {
      fail('HTMLの静的変換が、導入先で動いていません');
    }
    const css = await (await fetch(`${grant.filesBaseUrl}site.css`)).text();
    if (css !== '.a{color:red}.b{}') fail(`CSSの変換が、導入先で動いていません: ${css}`);
    if ((await fetch(`${grant.filesBaseUrl}a.md`)).status !== 404) {
      fail('登録していないfileが、表示用のlistenerから配信されています');
    }
    if (htmlId) runJson('vo', ['close', htmlId]);

    // 手順6の続き: 導入先だけで、scriptを動かす表示と、HTMLへの同梱SDKの注入が動く。
    writeFileSync(join(installDir, 'site', 'app.html'), '<script>document.title="app"</script>');
    const interactiveAsk = runJson<{ request: { requestId: string; documentId: string } }>('vo', [
      'ask',
      'q.json',
      '--view',
      'site/app.html',
      '--html-mode',
      'interactive',
    ]).request;
    const bridged = await post<{ documentUrl: string; bridge: { instanceId: string } | null }>(
      `/feedback/${interactiveAsk.requestId}/render-grants`,
      {},
      token,
    );
    const appResponse = await fetch(bridged.documentUrl);
    const appHtml = await appResponse.text();
    if (
      bridged.bridge === null ||
      !appHtml.includes(bridged.bridge.instanceId) ||
      !appHtml.includes('<script>document.title="app"</script>') ||
      !(appResponse.headers.get('content-security-policy') ?? '').includes('sandbox allow-scripts')
    ) {
      fail('scriptを動かす表示と、同梱SDKの注入が、導入先で動いていません');
    }
    runJson('vo', ['feedback', 'cancel', interactiveAsk.requestId]);
    runJson('vo', ['close', interactiveAsk.documentId]);

    runJson('vo', ['close', openedId]);
    if (runJson<Documents>('vde-open', ['list']).documents.length !== 0) {
      fail('voのcloseがvde-openの一覧に反映されていません');
    }

    // 手順7の前半: どちらの名前で起動したdaemonも、もう一方の名前で停止できる。
    runJson('vo', ['daemon', 'stop']);
    if (runJson<Status>('vde-open', ['daemon', 'status']).state !== 'stopped') {
      fail('voのdaemon stopでdaemonが停止していません');
    }

    // 手順5（CLI-004）: 両名から同時に20回開いても、daemonは1つ。
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        captureInstalledBinAsync(
          binDir,
          index % 2 === 0 ? 'vde-open' : 'vo',
          ['open', 'a.md', '--json'],
          {
            cwd: installDir,
            env,
          },
        ),
      ),
    );
    const ids = new Set<string>();
    for (const result of results) {
      if (result.status !== 0) fail(`同時openが exit ${String(result.status)}: ${result.stderr}`);
      const id = (JSON.parse(result.stdout) as Envelope<Documents>).data.documents[0]?.documentId;
      if (id) ids.add(id);
    }
    if (ids.size !== 1) fail(`同時openで文書が${String(ids.size)}件になりました`);
    if (runJson<Documents>('vo', ['list']).documents.length !== 1)
      fail('同じfileが重複して登録されています');
    const started = readFileSync(join(stateHome, 'logs', 'daemon.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"event":"daemon.started"'));
    // 手順4で1回、同時openで1回。同時openの中で複数のdaemonが起動していないこと。
    if (started.length !== 2) fail(`daemonの起動回数が想定と違います: ${String(started.length)}`);
  } finally {
    // 手順7: 検証で起動したdaemonを必ず止める。
    captureInstalledBin(binDir, 'vde-open', ['daemon', 'stop'], { cwd: installDir, env });
  }
  if (runJson<Status>('vo', ['daemon', 'status']).state !== 'stopped') {
    fail('検証後にdaemonが残っています');
  }
}

async function main(): Promise<void> {
  const tarball = packTarball();
  // 空白と日本語を含むpathでも導入・起動できることを同時に確かめる。
  const installDir = mkdtempSync(join(tmpdir(), 'vde-open pack 検証-'));
  try {
    await verifyInstalled(tarball, installDir);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
  console.log(`pack-smoke: PASS CLI-002 CLI-003 CLI-004 (${tarball})`);
}

try {
  await main();
} catch (error) {
  // 後始末を終えてから終了させるため、process.exitは呼ばない。
  process.exitCode = 1;
  if (error instanceof SmokeFailure) {
    console.error(`pack-smoke: FAIL: ${error.message}`);
  } else {
    console.error('pack-smoke: FAIL');
    console.error(error);
  }
}
