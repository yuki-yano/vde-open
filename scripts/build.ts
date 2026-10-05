// Build the CLI and the Web UI, and place the Web UI under dist/web of the distributed package.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { withStagedOutputs } from './build-output.ts';
import { cliDir, repoRoot, runNodeBinAsync, webDir } from './lib.ts';
import {
  findPackageDir,
  packagesOfModules,
  readPackage,
  renderNotices,
  siblingsOf,
} from './notices.ts';

const cliDist = join(cliDir, 'dist');
const controller = new AbortController();
let interrupted = 0;
process.once('SIGINT', () => {
  interrupted = 130;
  controller.abort(new Error('Build interrupted.'));
});
process.once('SIGTERM', () => {
  interrupted = 143;
  controller.abort(new Error('Build interrupted.'));
});

try {
  await withStagedOutputs(cliDir, async (stage) => {
    const stagedCli = join(stage, 'cli');
    const stagedCliDist = join(stagedCli, 'dist');
    const stagedWebDist = join(stage, 'web', 'dist');

    // Neither bundler may clean the distribution currently used by linked commands.
    await runNodeBinAsync(
      cliDir,
      'tsdown',
      ['--out-dir', stagedCliDist],
      { cwd: cliDir },
      controller.signal,
    );
    await runNodeBinAsync(
      webDir,
      'vite',
      ['build', '--outDir', stagedWebDist],
      { cwd: webDir },
      controller.signal,
    );

    // Read the list of bundled modules and remove it from the distribution.
    const MODULE_LIST = 'bundled-modules.json';
    const takeModules = (path: string): string[] => {
      const ids = JSON.parse(readFileSync(path, 'utf8')) as string[];
      rmSync(path);
      return ids;
    };
    const cliModules = takeModules(join(stagedCliDist, MODULE_LIST));
    const webModules = takeModules(join(stagedWebDist, MODULE_LIST));
    cpSync(stagedWebDist, join(stagedCliDist, 'web'), { recursive: true });

    // CSS imports do not appear in the bundled module list, so add their packages.
    const CSS_PACKAGES = ['tailwindcss', 'tw-animate-css', 'shadcn', '@fontsource-variable/geist'];
    const webRoots = [join(webDir, 'node_modules')];
    const packageDirs = new Map([
      ...packagesOfModules(cliModules, [siblingsOf(join(cliDir, 'node_modules', 'tsdown'))]),
      ...packagesOfModules(webModules, [
        ...webRoots,
        siblingsOf(join(webDir, 'node_modules', 'vite')),
      ]),
    ]);
    for (const name of CSS_PACKAGES) {
      const dir = findPackageDir(name, webRoots);
      packageDirs.set(dir, dir);
    }
    writeFileSync(
      join(stagedCli, 'THIRD_PARTY_NOTICES.md'),
      renderNotices([...packageDirs.keys()].map((dir) => readPackage(dir))),
    );

    const packagedFiles = ['README.md', 'LICENSE', 'docs/agent-usage.md', 'skills'];
    for (const path of packagedFiles) {
      const source = join(repoRoot, path);
      if (!existsSync(source)) continue;
      const target = join(stagedCli, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }

    controller.signal.throwIfAborted();
    return [
      { staged: stagedWebDist, target: join(webDir, 'dist') },
      ...['THIRD_PARTY_NOTICES.md', ...packagedFiles, 'dist'].map((path) => ({
        staged: join(stagedCli, path),
        target: join(cliDir, path),
      })),
    ];
  });
  console.log(`build: ${cliDist}`);
} catch (error) {
  if (!interrupted) console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = interrupted || 1;
}
