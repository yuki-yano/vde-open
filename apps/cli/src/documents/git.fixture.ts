// Builds the Git layouts repository detection reads, without running `git`. Used by tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export function writeFile(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// A Git directory: HEAD, objects, and refs.
export function gitDir(dir: string, head = 'ref: refs/heads/main\n'): string {
  mkdirSync(join(dir, 'objects'), { recursive: true });
  mkdirSync(join(dir, 'refs'), { recursive: true });
  writeFile(join(dir, 'HEAD'), head);
  return dir;
}

// The layout `git worktree add` creates. With relativePaths, the layout of --relative-paths.
// Returns the worktree's administrative directory.
export function worktree(
  commonDir: string,
  checkout: string,
  name: string,
  options: { head?: string; relativePaths?: boolean } = {},
): string {
  const admin = join(commonDir, 'worktrees', name);
  mkdirSync(admin, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  writeFile(join(admin, 'HEAD'), options.head ?? `ref: refs/heads/${name}\n`);
  writeFile(join(admin, 'commondir'), '../..\n');
  writeFile(
    join(admin, 'gitdir'),
    `${options.relativePaths ? relative(admin, join(checkout, '.git')) : join(checkout, '.git')}\n`,
  );
  writeFile(
    join(checkout, '.git'),
    `gitdir: ${options.relativePaths ? relative(checkout, admin) : admin}\n`,
  );
  return admin;
}
