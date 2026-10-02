// CLIとWeb UIをビルドし、Web UIを配布packageのdist/webへ置く。
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { cliDir, repoRoot, runNodeBin, webDir } from './lib.ts';

const cliDist = join(cliDir, 'dist');

// tsdownのcleanがdist/webを消すので、必ずWebのcopyより先に実行する。
runNodeBin(cliDir, 'tsdown', [], { cwd: cliDir });
runNodeBin(webDir, 'vite', ['build'], { cwd: webDir });

const webTarget = join(cliDist, 'web');
rmSync(webTarget, { recursive: true, force: true });
cpSync(join(webDir, 'dist'), webTarget, { recursive: true });

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
