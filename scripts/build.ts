// Build the CLI and the Web UI, and place the Web UI under dist/web of the distributed package.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { cliDir, repoRoot, runNodeBin, webDir } from './lib.ts';
import {
  findPackageDir,
  packagesOfModules,
  readPackage,
  renderNotices,
  siblingsOf,
} from './notices.ts';

const cliDist = join(cliDir, 'dist');

// tsdown's clean removes dist/web, so always run it before copying the Web UI.
runNodeBin(cliDir, 'tsdown', [], { cwd: cliDir });
runNodeBin(webDir, 'vite', ['build'], { cwd: webDir });

// Read the list of bundled modules (an intermediate file) and remove it from the distribution.
const MODULE_LIST = 'bundled-modules.json';
const takeModules = (path: string): string[] => {
  const ids = JSON.parse(readFileSync(path, 'utf8')) as string[];
  rmSync(path);
  return ids;
};
const cliModules = takeModules(join(cliDist, MODULE_LIST));
const webModules = takeModules(join(webDir, 'dist', MODULE_LIST));

const webTarget = join(cliDist, 'web');
rmSync(webTarget, { recursive: true, force: true });
cpSync(join(webDir, 'dist'), webTarget, { recursive: true });

// License notices of dependencies. Packages pulled in by CSS `@import` (processed by Tailwind CSS)
// do not appear as bundled modules, so add them by name (apps/web/src/index.css).
const CSS_PACKAGES = ['tailwindcss', 'tw-animate-css', 'shadcn', '@fontsource-variable/geist'];
const webRoots = [join(webDir, 'node_modules')];
const packageDirs = new Map([
  ...packagesOfModules(cliModules, [siblingsOf(join(cliDir, 'node_modules', 'tsdown'))]),
  ...packagesOfModules(webModules, [...webRoots, siblingsOf(join(webDir, 'node_modules', 'vite'))]),
]);
for (const name of CSS_PACKAGES) {
  const dir = findPackageDir(name, webRoots);
  packageDirs.set(dir, dir);
}
writeFileSync(
  join(cliDir, 'THIRD_PARTY_NOTICES.md'),
  renderNotices([...packageDirs.keys()].map((dir) => readPackage(dir))),
);

// Documents, the license, and the agent skill included in the distributed package's files.
// Skip the ones that do not exist yet.
const packagedFiles: Array<[source: string, target: string]> = [
  [join(repoRoot, 'README.md'), join(cliDir, 'README.md')],
  [join(repoRoot, 'LICENSE'), join(cliDir, 'LICENSE')],
  [join(repoRoot, 'docs', 'agent-usage.md'), join(cliDir, 'docs', 'agent-usage.md')],
  [join(repoRoot, 'skills'), join(cliDir, 'skills')],
];
for (const [source, target] of packagedFiles) {
  rmSync(target, { recursive: true, force: true });
  if (!existsSync(source)) continue;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

console.log(`build: ${cliDist}`);
