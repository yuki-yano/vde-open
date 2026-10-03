// For development: start the daemon in the foreground with a dedicated state home, and serve the UI from the Vite dev server (spec 14.1).
// Only a daemon run from source accepts the development origin allowance. It has no effect on the distribution.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { captureCommand, cliDir, repoRoot, webDir } from './lib.ts';

const BACKEND_PORT = 43117;
const UI_ORIGIN = 'http://127.0.0.1:5173';
const BACKEND_ORIGIN = `http://127.0.0.1:${String(BACKEND_PORT)}`;
const cliEntry = join(cliDir, 'src', 'cli.ts');

const env = {
  ...process.env,
  // Do not touch the normal state and daemon.
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
  // When either one exits, stop the other too. Leave no child process behind.
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

// Once the daemon is ready, show the one-time URL for opening it in the development UI.
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
      `\nDevelopment UI: ${url.replace(BACKEND_ORIGIN, UI_ORIGIN)}\n(valid for 60 seconds, once only)\n`,
    );
    return;
  }
  if (Date.now() < deadline) setTimeout(printUrl, 500);
  else console.error('Could not confirm that the daemon is ready.');
};
setTimeout(printUrl, 1000);
