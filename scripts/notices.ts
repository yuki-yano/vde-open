// Build the license notices of external packages included in the distribution (spec 16.3, ADR-0001).
// Identify packages from the list of bundled modules (written by the tsdown and vite plugins).
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  // license, notice, and copying files included in the package.
  files: Array<{ name: string; text: string }>;
}

// Runtime code the bundler puts into the output. The module ids are virtual and have no package path.
const VIRTUAL_MODULES: Record<string, string> = {
  '\0rolldown/runtime.js': 'rolldown',
  '\0vite/modulepreload-polyfill.js': 'vite',
};

const NOTICE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

// Find the directory of the package that contains a module from its module ID.
// Depending on the bundler, the ID separator is `/` (Vite normalizes to `/` even on Windows) or the OS separator.
// Normalize both to `/` (Node file operations accept `/`-separated paths on Windows too).
export function packageDirOfModule(id: string): string | null {
  const normalized = id.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  const rest = normalized.slice(index + marker.length).split('/');
  const depth = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= depth) return null;
  return `${normalized.slice(0, index + marker.length)}${rest.slice(0, depth).join('/')}`;
}

export function readPackage(dir: string): BundledPackage {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    license?: string;
  };
  const files = readdirSync(dir)
    .filter((name) => NOTICE_FILE.test(name))
    .toSorted()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').trim() }));
  if (!manifest.name || !manifest.version)
    throw new Error(`package.json of ${dir} lacks a name or a version`);
  if (!manifest.license && files.length === 0) {
    throw new Error(
      `license of ${manifest.name} is unknown (neither in package.json nor in a file)`,
    );
  }
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? '(not stated in package.json)',
    files,
  };
}

// Find a package directory by name. Look at `<root>/<name>` in the order of roots.
export function findPackageDir(name: string, roots: string[]): string {
  for (const root of roots) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  throw new Error(`package ${name} not found`);
}

// In the pnpm layout, the place where the packages a package depends on live (next to that package).
export function siblingsOf(packageDir: string): string {
  const real = realpathSync(packageDir);
  const name = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as { name: string };
  return name.name.startsWith('@') ? dirname(dirname(real)) : dirname(real);
}

// Collect the external packages that went into the bundle from the list of module ids.
// virtualRoots is where to look for the packages of virtual modules (bundler runtime).
export function packagesOfModules(ids: string[], virtualRoots: string[]): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const id of ids) {
    const virtual = VIRTUAL_MODULES[id];
    const dir =
      virtual !== undefined
        ? findPackageDir(virtual, virtualRoots)
        : id.startsWith('\0')
          ? null
          : packageDirOfModule(id);
    if (dir === null) continue;
    const real = realpathSync(dir);
    dirs.set(real, real);
  }
  return dirs;
}

export function renderNotices(packages: BundledPackage[]): string {
  const sorted = packages.toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  const lines = [
    '# Third-party notices',
    '',
    'The distribution (`dist/`) of vde-open (MIT) includes code, styles, and fonts from the following packages.',
    'Each package is subject to its own license. `pnpm build` generates this list from the bundle contents.',
    '',
  ];
  for (const item of sorted) {
    lines.push(`## ${item.name}@${item.version}`, '', `License: ${item.license}`, '');
    if (item.files.length === 0) {
      lines.push('(the package does not include a license file)', '');
    }
    for (const file of item.files) {
      // Wrap in a fence longer than any run of backticks in the text (so the text cannot close the fence).
      const longest = Math.max(0, ...[...file.text.matchAll(/`+/g)].map((run) => run[0].length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      lines.push(`### ${file.name}`, '', `${fence}text`, file.text, fence, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
