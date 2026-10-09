import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRuntimeLocation } from '../../apps/cli/src/persistence/paths.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
// The distribution entry point. Test the build output, not the source.
const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'cli.js');

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface E2eHome {
  home: string;
  work: string;
  run: (args: string[]) => Promise<CliResult>;
  json: <T>(args: string[]) => Promise<T>;
  write: (relativePath: string, content: string | Buffer) => string;
  // Like an editor save: write to a temporary file, then replace by rename.
  atomicWrite: (relativePath: string, content: string) => void;
  uiUrl: () => Promise<string>;
  cleanup: () => Promise<void>;
}

// extraEnv is extra environment variables passed to the daemon and CLI (used, for example, to check that development settings are disabled in the distribution).
export function createE2eHome(extraEnv: Record<string, string> = {}): E2eHome {
  if (!existsSync(cliEntry)) {
    throw new Error('apps/cli/dist/cli.js not found. Run pnpm build first.');
  }
  const base = mkdtempSync(join(tmpdir(), 'vde-open-e2e-'));
  const home = join(base, 'home');
  const work = join(base, 'work');
  mkdirSync(work);
  const env = { ...process.env, ...extraEnv, VDE_OPEN_HOME: home };

  const run = (args: string[]): Promise<CliResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliEntry, ...args], {
        cwd: work,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
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
      child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    });

  const json = async <T>(args: string[]): Promise<T> => {
    const result = await run([...args, '--json']);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; data: T };
    if (!envelope.ok) throw new Error(`${args.join(' ')} failed: ${result.stdout}`);
    return envelope.data;
  };

  return {
    home,
    work,
    run,
    json,
    write(relativePath, content) {
      const path = join(work, relativePath);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
      return path;
    },
    atomicWrite(relativePath, content) {
      const path = join(work, relativePath);
      const temp = `${path}.tmp-${Date.now().toString()}`;
      writeFileSync(temp, content);
      renameSync(temp, path);
    },
    async uiUrl() {
      return (await json<{ uiUrl: string }>(['daemon', 'status'])).uiUrl;
    },
    async cleanup() {
      let pid: number | null = null;
      try {
        pid = (
          JSON.parse(readFileSync(join(home, 'runtime-pointer.json'), 'utf8')) as { pid: number }
        ).pid;
      } catch {
        pid = null;
      }
      await run(['daemon', 'stop']).catch(() => undefined);
      if (pid !== null) {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already stopped.
        }
      }
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
