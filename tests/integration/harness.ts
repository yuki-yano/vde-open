import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../../apps/cli/src/cli/run.ts';
import { resolveRuntimeLocation } from '../../apps/cli/src/persistence/paths.ts';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const cliEntry = join(repoRoot, 'apps', 'cli', 'src', 'cli.ts');
export const fixturesDir = join(repoRoot, 'tests', 'fixtures', 'handoff');

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  // Checks that stdout is exactly one JSON value plus a newline, and returns it.
  json: <T = Record<string, unknown>>() => JsonEnvelope<T>;
}

export interface JsonEnvelope<T> {
  schemaVersion: number;
  ok: boolean;
  data: T;
  error: { code: string; message: string; retryable: boolean; details: Record<string, unknown> };
  warnings: Array<{ code: string; message: string }>;
  meta: { command: string; catalogVersion?: number };
}

export interface RunOptions {
  cwd?: string;
  // Content redirected to stdin. If omitted, equivalent to /dev/null (no input).
  stdin?: string | Buffer;
  env?: Record<string, string>;
}

export interface TerminalResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TestHome {
  // State root dedicated to the test. The real state is not touched.
  home: string;
  // Working directory for fixtures. Also the CLI's cwd.
  work: string;
  run: (args: string[], options?: RunOptions) => Promise<RunResult>;
  // Runs the CLI as if stdout were a terminal. A child process cannot reproduce a terminal, so it runs in the same process.
  // To avoid opening a real browser, the file to run as the browser is required.
  runAsTerminal: (args: string[], browser: string) => Promise<TerminalResult>;
  write: (relativePath: string, content: string | Buffer) => string;
  cleanup: () => Promise<void>;
}

function execute(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdinFd: number | null,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env,
      stdio: [stdinFd ?? 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr,
        json: <T>() => {
          if (!stdout.endsWith('\n') || stdout.slice(0, -1).includes('\n')) {
            throw new Error(
              `stdout is not exactly one JSON value: ${JSON.stringify(stdout)}\n${stderr}`,
            );
          }
          return JSON.parse(stdout) as JsonEnvelope<T>;
        },
      });
    });
  });
}

export function createTestHome(): TestHome {
  const base = mkdtempSync(join(tmpdir(), 'vde-open-it-'));
  const home = join(base, 'home');
  const work = join(base, 'work');
  mkdirSync(work);
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    VDE_OPEN_HOME: home,
    ...extra,
  });

  const run = async (args: string[], options: RunOptions = {}): Promise<RunResult> => {
    let stdinFd: number | null = null;
    if (options.stdin !== undefined) {
      const stdinPath = join(
        base,
        `stdin-${Date.now().toString()}-${Math.random().toString(16).slice(2)}`,
      );
      writeFileSync(stdinPath, options.stdin);
      stdinFd = openSync(stdinPath, 'r');
    }
    try {
      return await execute(args, options.cwd ?? work, env(options.env), stdinFd);
    } finally {
      if (stdinFd !== null) closeSync(stdinFd);
    }
  };

  const runAsTerminal = async (args: string[], browser: string): Promise<TerminalResult> => {
    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(args, {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      cwd: work,
      environment: {
        env: env({ BROWSER: browser }),
        platform: process.platform,
        homeDir: process.env['HOME'] ?? '',
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
      },
      stdoutIsTty: true,
      stdin: { isPiped: false, read: () => Promise.resolve(Buffer.alloc(0)) },
    });
    return { exitCode, stdout, stderr };
  };

  return {
    home,
    work,
    run,
    runAsTerminal,
    write(relativePath, content) {
      const path = join(work, relativePath);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
      return path;
    },
    async cleanup() {
      // Stop only the daemon this test started. Read the pid from the pointer in the test state root.
      let pid: number | null = null;
      try {
        pid = (
          JSON.parse(readFileSync(join(home, 'runtime-pointer.json'), 'utf8')) as { pid: number }
        ).pid;
      } catch {
        pid = null;
      }
      await execute(['daemon', 'stop'], work, env(), null).catch(() => undefined);
      // Show shutdown steps that failed or timed out, to diagnose slow stops on CI runners.
      try {
        const lines = readFileSync(join(home, 'logs', 'daemon.jsonl'), 'utf8').split('\n');
        if (lines.some((line) => line.includes('"event":"daemon.shutdown_failed"'))) {
          const shutdown = lines.filter((line) => line.includes('"event":"daemon.shutdown'));
          console.warn(`daemon shutdown problems:\n${shutdown.join('\n')}`);
        }
      } catch {
        // No log (the daemon never started).
      }
      if (pid !== null) {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already stopped.
        }
      }
      // Do not leave the runtime directory for the test home behind.
      const { runtimeDir } = resolveRuntimeLocation(home, {
        env: {},
        platform: process.platform,
        homeDir: '',
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
      });
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export function fixture(name: string): Buffer {
  return readFileSync(join(fixturesDir, name));
}
