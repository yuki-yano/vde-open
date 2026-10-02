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
  // stdoutが「JSON 1個＋改行」だけであることを確かめて返す。
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
  // stdinへredirectする内容。未指定なら/dev/null相当（入力なし）。
  stdin?: string | Buffer;
  env?: Record<string, string>;
}

export interface TerminalResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TestHome {
  // 試験専用のstate root。本物のstateには触れない。
  home: string;
  // fixtureを置く作業directory。CLIのcwdにもなる。
  work: string;
  run: (args: string[], options?: RunOptions) => Promise<RunResult>;
  // stdoutが端末である条件でCLIを実行する。子processでは端末を再現できないので、同じprocessで動かす。
  // 本物のbrowserを開かないよう、browserとして実行するfileの指定を必須にする。
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
            throw new Error(`stdoutがJSON 1個ではありません: ${JSON.stringify(stdout)}\n${stderr}`);
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
      // この試験が起動したdaemonだけを止める。pidは試験用state rootのpointerから読む。
      let pid: number | null = null;
      try {
        pid = (
          JSON.parse(readFileSync(join(home, 'runtime-pointer.json'), 'utf8')) as { pid: number }
        ).pid;
      } catch {
        pid = null;
      }
      await execute(['daemon', 'stop'], work, env(), null).catch(() => undefined);
      if (pid !== null) {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {
          // すでに停止している。
        }
      }
      // 試験用homeに対応するruntime directoryを残さない。
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
