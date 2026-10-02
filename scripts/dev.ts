// 開発用: 専用のstate homeでdaemonを前景起動し、Viteの開発serverでUIを配信する（仕様14.1）。
// 開発用のorigin許可は、sourceから実行したdaemonだけが受け付ける。配布物には効かない。
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { captureCommand, cliDir, repoRoot, webDir } from './lib.ts';

const BACKEND_PORT = 43117;
const UI_ORIGIN = 'http://127.0.0.1:5173';
const BACKEND_ORIGIN = `http://127.0.0.1:${String(BACKEND_PORT)}`;
const cliEntry = join(cliDir, 'src', 'cli.ts');

const env = {
  ...process.env,
  // 通常のstateとdaemonに触れない。
  VDE_OPEN_HOME: join(repoRoot, '.dev-home'),
  VDE_OPEN_DEV_UI_ORIGIN: UI_ORIGIN,
  VDE_OPEN_DEV_BACKEND: BACKEND_ORIGIN,
};

const children: ChildProcess[] = [];
let stopping = false;

function stopAll(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}

function start(command: string, args: string[], cwd: string): ChildProcess {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  children.push(child);
  // どちらかが終わったら、もう一方も止める。子processを残さない。
  child.on('exit', (code) => {
    stopAll();
    if (code && process.exitCode === undefined) process.exitCode = code;
  });
  return child;
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

start(process.execPath, [cliEntry, 'serve', '--port', String(BACKEND_PORT)], repoRoot);
start(process.execPath, [join(webDir, 'node_modules', 'vite', 'bin', 'vite.js')], webDir);

// daemonの準備ができたら、開発用UIで開くための一回限りのURLを示す。
const deadline = Date.now() + 15_000;
const printUrl = () => {
  if (stopping) return;
  const result = captureCommand(process.execPath, [cliEntry, 'ui', '--print-url'], {
    cwd: repoRoot,
    env,
  });
  const url = result.stdout.trim();
  if (result.status === 0 && url.startsWith(BACKEND_ORIGIN)) {
    console.log(
      `\n開発用UI: ${url.replace(BACKEND_ORIGIN, UI_ORIGIN)}\n（60秒間・1回だけ有効です）\n`,
    );
    return;
  }
  if (Date.now() < deadline) setTimeout(printUrl, 500);
  else console.error('daemonの準備を確認できませんでした。');
};
setTimeout(printUrl, 1000);
