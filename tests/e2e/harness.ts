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
// 配布物のentry。sourceではなく、ビルド結果を試す。
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
  write: (relativePath: string, content: string) => string;
  // editorの保存と同じく、一時fileへ書いてからrenameで置き換える。
  atomicWrite: (relativePath: string, content: string) => void;
  // 一回限りのticketを含むURL。
  bootstrapUrl: () => Promise<string>;
  uiUrl: () => Promise<string>;
  cleanup: () => Promise<void>;
}

export function createE2eHome(): E2eHome {
  if (!existsSync(cliEntry)) {
    throw new Error('apps/cli/dist/cli.js がありません。先に pnpm build を実行してください。');
  }
  const base = mkdtempSync(join(tmpdir(), 'vde-open-e2e-'));
  const home = join(base, 'home');
  const work = join(base, 'work');
  mkdirSync(work);
  const env = { ...process.env, VDE_OPEN_HOME: home };

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
    if (!envelope.ok) throw new Error(`${args.join(' ')} が失敗しました: ${result.stdout}`);
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
    async bootstrapUrl() {
      const result = await run(['ui', '--print-url']);
      const url = result.stdout.trim();
      if (!url.includes('#bootstrap=')) throw new Error(`URLを取得できません: ${result.stderr}`);
      return url;
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
          // すでに停止している。
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
