// Checks that the Node.js and pnpm on PATH (from flake.nix) match the versions pinned in package.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { engines, packageManager } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  engines: { node: string };
  packageManager: string;
};
const pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();

assert.equal(
  process.versions.node,
  engines.node,
  'Node.js version does not match engines.node in package.json',
);
assert.equal(
  `pnpm@${pnpmVersion}`,
  packageManager,
  'pnpm version does not match packageManager in package.json',
);

console.log(`Node.js ${process.versions.node}: ${process.execPath}`);
console.log(`pnpm ${pnpmVersion}`);
