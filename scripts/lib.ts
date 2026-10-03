import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const cliDir = join(repoRoot, 'apps', 'cli');
export const webDir = join(repoRoot, 'apps', 'web');

const isWindows = process.platform === 'win32';

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface CaptureResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Invocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const cmdMetaChars = /([()\][%!^"`<>&|;, *?])/g;

// Quote one argument passed to cmd.exe. Same rules as cross-spawn.
// A .cmd shim goes through cmd.exe once more internally, so escape meta characters twice.
export function quoteForCmd(argument: string, forCmdShim: boolean): string {
  let quoted = argument.replace(/(\\*)"/g, '$1$1\\"');
  quoted = quoted.replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`;
  quoted = quoted.replace(cmdMetaChars, '^$1');
  if (forCmdShim) quoted = quoted.replace(cmdMetaChars, '^$1');
  return quoted;
}

// A .cmd on Windows cannot be started without a shell. shell: true does not quote arguments, so
// pass the already quoted command line to cmd.exe as is.
export function cmdShimInvocation(shimPath: string, args: string[]): Invocation {
  const commandLine = [
    shimPath.replace(cmdMetaChars, '^$1'),
    ...args.map((argument) => quoteForCmd(argument, true)),
  ].join(' ');
  return {
    command: process.env['comspec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function nodeBinInvocation(packageDir: string, packageName: string, args: string[]): Invocation {
  const manifestPath = join(packageDir, 'node_modules', packageName, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[packageName];
  if (!bin) throw new Error(`bin of ${packageName} not found: ${manifestPath}`);
  return { command: process.execPath, args: [join(dirname(manifestPath), bin), ...args] };
}

function pnpmInvocation(args: string[]): Invocation {
  // When started via pnpm, its executable can be called without a shell.
  const execPath = process.env['npm_execpath'];
  if (execPath && /pnpm/i.test(execPath)) {
    return /\.[cm]?js$/.test(execPath)
      ? { command: process.execPath, args: [execPath, ...args] }
      : { command: execPath, args };
  }
  if (isWindows) {
    throw new Error('Cannot locate the pnpm executable. Run it as `pnpm <script>`.');
  }
  return { command: 'pnpm', args };
}

function npmInvocation(args: string[]): Invocation {
  // Start the JS entry of the npm bundled with Node directly. Do not go through npm.cmd.
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (!cli) throw new Error(`npm bundled with Node not found: ${candidates.join(', ')}`);
  return { command: process.execPath, args: [cli, ...args] };
}

function installedBinInvocation(binDir: string, name: string, args: string[]): Invocation {
  if (isWindows) return cmdShimInvocation(join(binDir, `${name}.cmd`), args);
  return { command: join(binDir, name), args };
}

function describe(invocation: Invocation): string {
  return [invocation.command, ...invocation.args].join(' ');
}

function runInvocation(invocation: Invocation, options: RunOptions): void {
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
    windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${describe(invocation)} failed with exit ${String(result.status)}`);
  }
}

function captureInvocation(invocation: Invocation, options: RunOptions): CaptureResult {
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function runNodeBin(
  packageDir: string,
  packageName: string,
  args: string[],
  options: RunOptions,
): void {
  runInvocation(nodeBinInvocation(packageDir, packageName, args), options);
}

export function runPnpm(args: string[], options: RunOptions): void {
  runInvocation(pnpmInvocation(args), options);
}

export function runNpm(args: string[], options: RunOptions): void {
  runInvocation(npmInvocation(args), options);
}

export function captureNpm(args: string[], options: RunOptions): CaptureResult {
  return captureInvocation(npmInvocation(args), options);
}

export function captureCommand(
  command: string,
  args: string[],
  options: RunOptions,
): CaptureResult {
  return captureInvocation({ command, args }, options);
}

export function captureInstalledBin(
  binDir: string,
  name: string,
  args: string[],
  options: RunOptions,
): CaptureResult {
  return captureInvocation(installedBinInvocation(binDir, name, args), options);
}

// Async version for starting installed bins concurrently.
export function captureInstalledBinAsync(
  binDir: string,
  name: string,
  args: string[],
  options: RunOptions,
): Promise<CaptureResult> {
  const invocation = installedBinInvocation(binDir, name, args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
