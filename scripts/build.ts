// CLIとWeb UIをビルドし、Web UIを配布packageのdist/webへ置く。
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

// tsdownのcleanがdist/webを消すので、必ずWebのcopyより先に実行する。
runNodeBin(cliDir, 'tsdown', [], { cwd: cliDir });
runNodeBin(webDir, 'vite', ['build'], { cwd: webDir });

// bundleに入れたmoduleの一覧（中間file）を読み、配布物からは消す。
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

// 依存のlicense notice。CSSの`@import`（Tailwind CSSが処理する）で入るpackageは、
// bundleのmoduleとして現れないので、名前で加える（apps/web/src/index.css）。
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

// 配布packageのfilesに含める文書。まだ無いものはcopyしない。
const packagedDocs: Array<[source: string, target: string]> = [
  [join(repoRoot, 'README.md'), join(cliDir, 'README.md')],
  [join(repoRoot, 'docs', 'agent-usage.md'), join(cliDir, 'docs', 'agent-usage.md')],
];
for (const [source, target] of packagedDocs) {
  rmSync(target, { force: true });
  if (!existsSync(source)) continue;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}

console.log(`build: ${cliDist}`);
