import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { watchBuildInputs, type BuildInput } from './build-inputs.ts';
import { createBuildQueue } from './build-queue.ts';
import { repoRoot } from './lib.ts';

const files = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'README.md',
  'LICENSE',
  'docs/agent-usage.md',
  'scripts/build.ts',
  'scripts/build-output.ts',
  'scripts/lib.ts',
  'scripts/notices.ts',
  'apps/cli/package.json',
  'apps/cli/tsconfig.json',
  'apps/cli/tsdown.config.ts',
  'apps/web/package.json',
  'apps/web/tsconfig.json',
  'apps/web/vite.config.ts',
  'apps/web/index.html',
  'packages/document/package.json',
  'packages/document/tsconfig.json',
  'packages/shared/package.json',
  'packages/shared/tsconfig.json',
];
const directories = [
  'apps/cli/src',
  'apps/web/src',
  'apps/web/public',
  'packages/document/src',
  'packages/shared/src',
  'skills',
];
const inputs: BuildInput[] = [
  ...files.map((path) => ({ path: join(repoRoot, path) })),
  ...directories.map((path) => ({ path: join(repoRoot, path), recursive: true })),
];

let child: ReturnType<typeof spawn> | null = null;
let stopping = false;

const queue = createBuildQueue(
  () =>
    new Promise<void>((resolve, reject) => {
      console.log('\nbuild:watch: building');
      child = spawn(process.execPath, [join(repoRoot, 'scripts', 'build.ts')], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        child = null;
        if (code === 0) {
          console.log('build:watch: updated. Run `vo daemon restart` then `vo ui` to use it.');
          resolve();
        } else reject(new Error(`Build ended with ${signal ?? `exit ${String(code)}`}.`));
      });
    }),
  (error) => {
    console.error(`build:watch: ${error instanceof Error ? error.message : String(error)}`);
    console.error('build:watch: waiting for the next change.');
  },
);

let closeInputs: (() => void) | undefined;
async function stop(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  closeInputs?.();
  child?.kill('SIGTERM');
  await queue.stop();
}

process.once('SIGINT', () => void stop(130));
process.once('SIGTERM', () => void stop(143));

try {
  closeInputs = watchBuildInputs(
    inputs,
    () => queue.request(),
    (error) => {
      console.error(`build:watch: could not watch inputs: ${error.message}`);
      void stop(1);
    },
  );
  console.log('build:watch: watching CLI, UI, shared sources, and package inputs. Ctrl+C to stop.');
  queue.request();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await stop(1);
}
