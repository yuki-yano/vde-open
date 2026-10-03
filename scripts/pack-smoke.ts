// Install the distribution tarball into an empty directory and verify both bins (spec 14.4).
// Runs the steps implemented so far. Add new steps here.
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
  captureNpm,
  cliDir,
  repoRoot,
  runNpm,
  runPnpm,
} from './lib.ts';

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

// Step 1: generate the tarball and inspect its contents.
function packTarball(): string {
  if (!existsSync(join(cliDir, 'dist', 'cli.js'))) {
    fail('apps/cli/dist/cli.js does not exist. Run pnpm build first.');
  }
  const artifactsDir = join(repoRoot, 'artifacts');
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });
  runPnpm(['pack', '--pack-destination', artifactsDir], { cwd: cliDir });
  const tarballs = readdirSync(artifactsDir).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) fail(`expected exactly one tarball: ${tarballs.join(', ')}`);
  const tarball = join(artifactsDir, tarballs[0] as string);

  const listing = captureCommand('tar', ['-tzf', tarball], { cwd: repoRoot });
  if (listing.status !== 0) fail(`cannot read the tarball: ${listing.stderr}`);
  const entries = new Set(listing.stdout.split(/\r?\n/).filter(Boolean));
  for (const entry of [
    'package/package.json',
    'package/dist/cli.js',
    'package/dist/daemon.js',
    'package/dist/workers/parse-worker.js',
    'package/dist/workers/search-worker.js',
    'package/dist/web/index.html',
    'package/docs/agent-usage.md',
    'package/README.md',
    'package/LICENSE',
    'package/skills/vde-open/SKILL.md',
    'package/THIRD_PARTY_NOTICES.md',
  ]) {
    if (!entries.has(entry)) fail(`the tarball lacks ${entry}`);
  }
  for (const entry of entries) {
    if (entry.endsWith('bundled-modules.json'))
      fail(`the tarball contains an intermediate file: ${entry}`);
  }
  // License notices of bundled dependencies (JS, CSS, fonts) are present (spec 16.3, ADR-0001).
  const notices = captureCommand('tar', ['-xzOf', tarball, 'package/THIRD_PARTY_NOTICES.md'], {
    cwd: repoRoot,
  }).stdout;
  for (const [name, text] of [
    ['minisearch', 'Copyright'],
    ['hono', 'Copyright'],
    ['zod', 'Copyright'],
    ['react-dom', 'Copyright'],
    ['@base-ui/react', 'Copyright'],
    ['tailwindcss', 'Copyright'],
    ['@fontsource-variable/geist', 'SIL OPEN FONT LICENSE'],
  ] as const) {
    const start = notices.indexOf(`\n## ${name}@`);
    if (start === -1) fail(`THIRD_PARTY_NOTICES.md lacks ${name}`);
    const next = notices.indexOf('\n## ', start + 1);
    if (!notices.slice(start, next === -1 ? undefined : next).includes(text)) {
      fail(`${name} in THIRD_PARTY_NOTICES.md lacks "${text}"`);
    }
  }
  // CLI-015: the install target needs no build or dependency installation (no install scripts, no runtime dependencies).
  const manifest = captureCommand('tar', ['-xzOf', tarball, 'package/package.json'], {
    cwd: repoRoot,
  });
  const packed = JSON.parse(manifest.stdout) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (packed.scripts?.[hook] !== undefined) fail(`the tarball has a ${hook} script`);
  }
  if (Object.keys(packed.dependencies ?? {}).length > 0) {
    fail(
      `the tarball has runtime dependencies: ${Object.keys(packed.dependencies ?? {}).join(', ')}`,
    );
  }
  for (const entry of entries) {
    if (entry.startsWith('package/src/') || entry.endsWith('.ts')) {
      fail(`the tarball contains source: ${entry}`);
    }
  }
  return tarball;
}

async function verifyInstalled(tarball: string, installDir: string): Promise<void> {
  // Step 2: install only the tarball into an empty directory. Do not query the registry.
  writeFileSync(join(installDir, 'package.json'), '{"private":true}\n');
  // CLI-014: installation does not change shell config files or an existing, different `vo`.
  // Install with a test HOME (holding existing shell config files) and compare the contents before and after.
  const home = join(installDir, 'home');
  mkdirSync(home);
  const shellFiles = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'];
  for (const name of ['.zshrc', '.bashrc']) {
    writeFileSync(join(home, name), `# ${name} (for the test)\nexport VDE_OPEN_SMOKE=1\n`);
  }
  const shellState = () =>
    JSON.stringify(
      shellFiles.map((name) => {
        const path = join(home, name);
        return [name, existsSync(path) ? readFileSync(path, 'utf8') : null];
      }),
    );
  const shellBefore = shellState();
  const npmEnv = { ...process.env, HOME: home, USERPROFILE: home };
  runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: installDir,
    env: npmEnv,
  });

  // Installing into a target that already has a different `vo` (the global prefix bin, a place on PATH) does not replace that `vo`.
  // Without --force, npm aborts the installation instead of replacing a bin that belongs to no other package (EEXIST).
  const prefix = join(installDir, 'global-prefix');
  const prefixBin = process.platform === 'win32' ? prefix : join(prefix, 'bin');
  mkdirSync(prefixBin, { recursive: true });
  const existingName = process.platform === 'win32' ? 'vo.cmd' : 'vo';
  const existingVo =
    process.platform === 'win32' ? '@echo existing-vo\r\n' : '#!/bin/sh\necho existing-vo\n';
  writeFileSync(join(prefixBin, existingName), existingVo, { mode: 0o755 });
  const global = captureNpm(
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    { cwd: installDir, env: npmEnv },
  );
  if (readFileSync(join(prefixBin, existingName), 'utf8') !== existingVo) {
    fail('installation changed the existing, different vo');
  }
  if (global.status === 0)
    fail('installation succeeded into a target that already has a different vo');
  if (!global.stderr.includes('EEXIST')) {
    fail(
      `installation failed for a reason other than the conflict with the existing vo: ${global.stderr}`,
    );
  }
  if (shellState() !== shellBefore) fail('installation changed shell config files');

  // Make the bin shebang start the Node used for this verification.
  // Keep the state in a test home inside the install target, not touching the normal daemon and state.
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
      fail(
        `${name} ${args.join(' ')} exited with ${String(result.status)}: ${result.stderr}${result.stdout}`,
      );
    }
    return result.stdout;
  };

  // Step 3 (CLI-002): version and help match between both names.
  for (const args of [['--version'], ['--help']]) {
    const long = runBin('vde-open', args);
    const short = runBin('vo', args);
    if (long.trim() === '') fail(`output of vde-open ${args.join(' ')} is empty`);
    if (long !== short) fail(`${args.join(' ')} differs between vde-open and vo`);
  }

  interface Envelope<T> {
    ok: boolean;
    data: T;
  }
  const runJson = <T>(name: string, args: string[]): T => {
    const envelope = JSON.parse(runBin(name, [...args, '--json'])) as Envelope<T>;
    if (!envelope.ok) fail(`${name} ${args.join(' ')} failed`);
    return envelope.data;
  };
  type Documents = { documents: Array<{ documentId: string }> };
  type Status = { state: string; daemonId: string | null };

  try {
    // Step 4 (CLI-003): a document opened with the long name can be listed and closed with the short name.
    writeFileSync(join(installDir, 'a.md'), '# pack検証\n');
    const opened = runJson<Documents>('vde-open', ['open', 'a.md']);
    const listed = runJson<Documents>('vo', ['list']);
    const openedId = opened.documents[0]?.documentId;
    if (!openedId || listed.documents.map((document) => document.documentId).join() !== openedId) {
      fail('the document opened with vde-open does not match the vo list');
    }
    const daemonId = runJson<Status>('vo', ['daemon', 'status']).daemonId;
    if (runJson<Status>('vde-open', ['daemon', 'status']).daemonId !== daemonId) {
      fail('vde-open and vo use different daemons');
    }
    // Step 6: from a cwd outside the repo, the bundled UI and parse worker work. Files in cwd are not served.
    const outline = runJson<{ outline: unknown[] }>('vo', ['read', openedId, '--outline']);
    if (outline.outline.length !== 1) fail('cannot get headings with the bundled parse worker');
    const uiUrl = runJson<{ uiUrl: string }>('vde-open', ['daemon', 'status']).uiUrl;
    const page = await fetch(uiUrl);
    const html = await page.text();
    const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (page.status !== 200 || !html.includes('id="root"') || !script) {
      fail('the bundled UI is not served');
    }
    if ((await fetch(new URL(script, uiUrl))).status !== 200) fail('the UI script is not served');
    if ((await fetch(new URL('a.md', uiUrl))).status !== 404)
      fail('a file in cwd is served from the UI origin');
    // CLI-013: secret files in cwd are not served from the UI origin either.
    writeFileSync(join(installDir, '.env'), 'SECRET=pack-smoke\n');
    for (const path of ['.env', '../.env', '%2e%2e/.env']) {
      const response = await fetch(new URL(path, uiUrl));
      if (response.status !== 404 || (await response.text()).includes('SECRET=')) {
        fail(`a secret file in cwd is served from the UI origin: ${path}`);
      }
    }

    // Step 6, continued: the search worker (bundled MiniSearch) works with only the install target.
    const found = runJson<{ hits: Array<{ documentId: string }>; incomplete: boolean }>('vo', [
      'search',
      'pack検証',
    ]);
    if (found.incomplete || found.hits[0]?.documentId !== openedId) {
      fail('cannot search the opened document with the bundled search worker');
    }

    // Step 6, continued: creating a question and fetching it for the Agent (without draft answers) work with only the install target.
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
      fail('cannot create and fetch a question in the install target');
    }
    runJson('vo', ['feedback', 'cancel', asked.requestId]);

    // Step 6, continued: static HTML conversion (bundled parse5 and css-tree) and the preview listener work with only the install target.
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
      if (!envelope.ok) fail(`${path} failed (${String(response.status)})`);
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
      fail('static HTML conversion does not work in the install target');
    }
    const css = await (await fetch(`${grant.filesBaseUrl}site.css`)).text();
    if (css !== '.a{color:red}.b{}')
      fail(`CSS conversion does not work in the install target: ${css}`);
    if ((await fetch(`${grant.filesBaseUrl}a.md`)).status !== 404) {
      fail('an unregistered file is served from the preview listener');
    }
    if (htmlId) runJson('vo', ['close', htmlId]);

    // Step 6, continued: the interactive view and injecting the bundled SDK into HTML work with only the install target.
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
      fail('the interactive view and the bundled SDK injection do not work in the install target');
    }
    runJson('vo', ['feedback', 'cancel', interactiveAsk.requestId]);
    runJson('vo', ['close', interactiveAsk.documentId]);

    runJson('vo', ['close', openedId]);
    if (runJson<Documents>('vde-open', ['list']).documents.length !== 0) {
      fail('close from vo is not reflected in the vde-open list');
    }

    // Step 7, first half: a daemon started with either name can be stopped with the other name.
    runJson('vo', ['daemon', 'stop']);
    if (runJson<Status>('vde-open', ['daemon', 'status']).state !== 'stopped') {
      fail('daemon stop from vo did not stop the daemon');
    }

    // Step 5 (CLI-004): opening 20 times concurrently from both names still gives one daemon.
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
      if (result.status !== 0)
        fail(`concurrent open exited with ${String(result.status)}: ${result.stderr}`);
      const id = (JSON.parse(result.stdout) as Envelope<Documents>).data.documents[0]?.documentId;
      if (id) ids.add(id);
    }
    if (ids.size !== 1) fail(`concurrent open produced ${String(ids.size)} documents`);
    if (runJson<Documents>('vo', ['list']).documents.length !== 1)
      fail('the same file is registered more than once');
    const started = readFileSync(join(stateHome, 'logs', 'daemon.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"event":"daemon.started"'));
    // Once in step 4 and once in the concurrent open. No multiple daemons must have started during the concurrent open.
    if (started.length !== 2) fail(`unexpected number of daemon starts: ${String(started.length)}`);
  } finally {
    // Step 7: always stop the daemon started by the verification.
    captureInstalledBin(binDir, 'vde-open', ['daemon', 'stop'], { cwd: installDir, env });
  }
  if (runJson<Status>('vo', ['daemon', 'status']).state !== 'stopped') {
    fail('a daemon remains after the verification');
  }
}

async function main(): Promise<void> {
  const tarball = packTarball();
  // Also confirms that installation and startup work with a path containing spaces and Japanese.
  const installDir = mkdtempSync(join(tmpdir(), 'vde-open pack 検証-'));
  try {
    await verifyInstalled(tarball, installDir);
  } catch (error) {
    // Show the end of the daemon log to diagnose failures on CI runners (no secrets are logged).
    const log = join(installDir, 'state home', 'logs', 'daemon.jsonl');
    if (existsSync(log)) {
      console.error('pack-smoke: daemon log (last 40 lines):');
      console.error(readFileSync(log, 'utf8').trimEnd().split('\n').slice(-40).join('\n'));
    }
    throw error;
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
  console.log(`pack-smoke: PASS CLI-002 CLI-003 CLI-004 (${tarball})`);
}

try {
  await main();
} catch (error) {
  // Do not call process.exit, so that cleanup finishes before exiting.
  process.exitCode = 1;
  if (error instanceof SmokeFailure) {
    console.error(`pack-smoke: FAIL: ${error.message}`);
  } else {
    console.error('pack-smoke: FAIL');
    console.error(error);
  }
}
