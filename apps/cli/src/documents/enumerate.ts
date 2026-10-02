import { lstat, readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { VdeError, type DocumentFormat } from '@vde-open/shared';
import { glob, isDynamicPattern } from 'tinyglobby';

// 走査時の既定除外（仕様5.3）。隠しfile／directoryは名前の先頭で判定する。
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage']);

const FORMAT_BY_EXTENSION = new Map<string, DocumentFormat>([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.html', 'html'],
  ['.htm', 'html'],
]);

export function formatOfPath(path: string): DocumentFormat | null {
  return FORMAT_BY_EXTENSION.get(extname(path).toLowerCase()) ?? null;
}

export interface Candidate {
  absolutePath: string;
  displayPath: string;
  // 利用者がfileを直接指定したか。directory／globの展開結果はfalse。
  explicit: boolean;
}

export interface Expansion {
  candidates: Candidate[];
  // 対象文書が1件もなかった指定。
  emptyTargets: string[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

export function displayPathOf(cwd: string, absolutePath: string): string {
  const fromCwd = relative(cwd, absolutePath);
  const inside = fromCwd !== '' && !fromCwd.startsWith('..') && !isAbsolute(fromCwd);
  return (inside ? fromCwd : absolutePath).split(sep).join('/');
}

async function listDirectory(directory: string, recursive: boolean): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.toSorted((a, b) => compareText(a.name, b.name))) {
    if (isHidden(entry.name)) continue;
    const path = join(directory, entry.name);
    // symlinkはfileでもdirectoryでも辿らない。
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (recursive && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        found.push(...(await listDirectory(path, true)));
      }
      continue;
    }
    if (entry.isFile() && formatOfPath(path) !== null) found.push(path);
  }
  return found;
}

async function expandGlob(cwd: string, pattern: string): Promise<string[]> {
  const matches = await glob(pattern, {
    cwd,
    absolute: true,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: [...EXCLUDED_DIRECTORIES].map((name) => `**/${name}/**`),
  });
  const files: string[] = [];
  for (const match of matches.toSorted(compareText)) {
    if (formatOfPath(match) === null) continue;
    if ((await lstat(match)).isFile()) files.push(resolve(match));
  }
  return files;
}

// 指定されたpath・directory・globを、開く候補のfileへ展開する。
// directoryは対象文書を列挙するだけで、directoryそのものは公開しない（仕様1.4）。
export async function expandTargets(
  cwd: string,
  targets: string[],
  recursive: boolean,
): Promise<Expansion> {
  const candidates: Candidate[] = [];
  const emptyTargets: string[] = [];
  for (const target of targets) {
    const absolutePath = resolve(cwd, target);
    let kind: 'file' | 'directory' | 'missing';
    try {
      kind = (await stat(absolutePath)).isDirectory() ? 'directory' : 'file';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new VdeError('E_INVALID_SOURCE', `${target} を確認できません。`, {
          path: target,
          reason: code ?? 'unknown',
        });
      }
      kind = 'missing';
    }

    if (kind === 'file') {
      candidates.push({
        absolutePath,
        displayPath: displayPathOf(cwd, absolutePath),
        explicit: true,
      });
      continue;
    }
    let expanded: string[];
    if (kind === 'directory') {
      expanded = await listDirectory(absolutePath, recursive);
    } else if (isDynamicPattern(target)) {
      expanded = await expandGlob(cwd, target);
    } else {
      throw new VdeError('E_PATH_NOT_FOUND', `${target} が見つかりません。`, { path: target });
    }
    if (expanded.length === 0) emptyTargets.push(target);
    for (const path of expanded) {
      candidates.push({
        absolutePath: path,
        displayPath: displayPathOf(cwd, path),
        explicit: false,
      });
    }
  }
  return { candidates, emptyTargets };
}
