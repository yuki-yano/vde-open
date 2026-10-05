import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface BuildInput {
  path: string;
  recursive?: boolean;
}

// Watch source trees recursively and file inputs through their parent directories.
// Watching the parents also handles editor saves that replace the original inode.
export function watchBuildInputs(
  inputs: BuildInput[],
  onChange: () => void,
  onError: (error: Error) => void,
): () => void {
  const parents = new Map<string, Map<string, BuildInput>>();
  const parentWatchers: FSWatcher[] = [];
  const recursiveWatchers = new Map<string, FSWatcher>();
  let closed = false;

  const close = () => {
    closed = true;
    for (const watcher of parentWatchers) watcher.close();
    for (const watcher of recursiveWatchers.values()) watcher.close();
    recursiveWatchers.clear();
  };

  const attachRecursive = (path: string) => {
    recursiveWatchers.get(path)?.close();
    recursiveWatchers.delete(path);
    if (!existsSync(path)) return;
    const watcher = watch(path, { recursive: true }, (_event, name) => {
      if (!closed && (name === null || !/\.test\.[cm]?[jt]sx?$/.test(name))) onChange();
    });
    watcher.on('error', onError);
    recursiveWatchers.set(path, watcher);
  };

  try {
    for (const input of inputs) {
      const parent = dirname(input.path);
      let children = parents.get(parent);
      if (!children) {
        children = new Map();
        parents.set(parent, children);
      }
      children.set(basename(input.path), input);
      if (input.recursive) attachRecursive(input.path);
    }
    for (const [parent, children] of parents) {
      const watcher = watch(parent, (_event, name) => {
        if (closed) return;
        const changed = name === null ? [...children.values()] : [children.get(name)];
        try {
          for (const input of changed) {
            if (!input) continue;
            if (input.recursive) attachRecursive(join(parent, basename(input.path)));
            onChange();
          }
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      });
      watcher.on('error', onError);
      parentWatchers.push(watcher);
    }
    return close;
  } catch (error) {
    close();
    throw error;
  }
}
