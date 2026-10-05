import { constants } from 'node:fs';
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import type { RepositoryCheckout, RepositoryReason } from '@vde-open/shared';

import { readBounded } from './source-reader.ts';

// Finds which Git repository (and which checkout of it) a document belongs to.
// Git metadata next to a document is written by whoever owns that directory, so every file is read as untrusted input:
// regular files only, without following a final symlink, never blocking on a FIFO, and with a size limit.
// The `git` command is never run (it would read that directory's Git configuration).

type CheckoutInfo = RepositoryCheckout;

export type Detection =
  | { state: 'outside' }
  | {
      state: 'resolved';
      // The repository key: the common Git directory, or the checkout directory when the link to a repository cannot be verified.
      id: string;
      nameSegments: string[];
      // null when the document is inside the .git directory itself (for example, a removed worktree).
      checkout: CheckoutInfo | null;
      pathInCheckout: string[];
    }
  | {
      state: 'unresolved';
      // The directory where .git was found.
      id: string;
      nameSegments: string[];
      pathInCheckout: string[];
      reason: RepositoryReason;
    };

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

// The filesystem operations detection uses. Tests replace them to record and control every access.
export interface RepositoryFs {
  lstat(path: string): Promise<EntryKind>;
  stat(path: string): Promise<EntryKind>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  // Reads a regular file without following a final symlink. Returns null if it is larger than the limit.
  readSmall(path: string, limit: number): Promise<Buffer | null>;
}

// Upper limit for each Git metadata file (.git file, commondir, HEAD, gitdir).
export const METADATA_LIMIT = 4096;

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

function notRegularFile(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${path} is not a regular file.`), { code: 'EFTYPE' });
}

export const nodeRepositoryFs: RepositoryFs = {
  lstat: async (path) => kindOf(await lstat(path)),
  stat: async (path) => kindOf(await stat(path)),
  readlink: (path) => readlink(path),
  realpath: (path) => realpath(path),
  readSmall: async (path, limit) => {
    // The type is checked before opening: a symlink or a FIFO is never opened.
    const before = await lstat(path);
    if (!before.isFile()) throw notRegularFile(path);
    // O_NOFOLLOW and O_NONBLOCK guard against a swap after the check where they exist (they do not on Windows).
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      // Everywhere, including Windows: the file opened must be the regular file that was checked.
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) {
        throw notRegularFile(path);
      }
      return await readBounded(handle, limit);
    } finally {
      await handle.close();
    }
  },
};

// Runs at most `limit` operations at once. A stuck operation keeps its slot until it actually settles,
// so a hung network mount can never take every thread of the shared libuv pool.
export interface Limiter {
  run<T>(work: () => Promise<T>): Promise<T>;
  readonly active: number;
}

export function createLimiter(limit: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async run(work) {
      if (active < limit) active += 1;
      // The slot is handed over by the finishing operation, so nobody can take it in between.
      else await new Promise<void>((resolveTurn) => waiting.push(resolveTurn));
      try {
        return await work();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      }
    },
    get active() {
      return active;
    },
  };
}

export function limitRepositoryFs(fs: RepositoryFs, limiter: Limiter): RepositoryFs {
  return {
    lstat: (path) => limiter.run(() => fs.lstat(path)),
    stat: (path) => limiter.run(() => fs.stat(path)),
    readlink: (path) => limiter.run(() => fs.readlink(path)),
    realpath: (path) => limiter.run(() => fs.realpath(path)),
    readSmall: (path, size) => limiter.run(() => fs.readSmall(path, size)),
  };
}

class Unresolved extends Error {
  readonly reason: RepositoryReason;

  constructor(reason: RepositoryReason) {
    super(reason);
    this.reason = reason;
  }
}

// A missing or wrongly typed entry means the metadata is invalid. Any other failure (permission, I/O) means it could not be read.
function failureOf(error: unknown, invalid: RepositoryReason): Unresolved {
  if (error instanceof Unresolved) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EFTYPE') {
    return new Unresolved(invalid);
  }
  return new Unresolved('unreadable');
}

const HEX_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Reftable repositories keep this fixed content in HEAD for older Git versions.
const REFTABLE_HEAD = 'refs/heads/.invalid';

// The rules of `git check-ref-format` for a full ref name. The string holds raw bytes (latin1), so non-ASCII bytes pass as Git allows.
export function isValidRefName(ref: string): boolean {
  if (ref === '@' || ref.endsWith('/') || ref.endsWith('.')) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  if (/[\u0000- \u007f~^:?*[\\]/.test(ref)) return false;
  return ref
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

// Parses HEAD. Returns the branch name when HEAD points to refs/heads/, null for a detached HEAD and other refs.
// Throws when the content is not a HEAD.
export function parseHead(bytes: Buffer): string | null {
  const content = bytes.toString('latin1').replace(/\s+$/, '');
  if (HEX_OBJECT_ID.test(content)) return null;
  if (!content.startsWith('ref:')) throw new Unresolved('invalid-git-dir');
  const ref = content.slice('ref:'.length).replace(/^\s+/, '');
  if (ref === REFTABLE_HEAD) return null;
  if (!ref.startsWith('refs/') || !isValidRefName(ref)) throw new Unresolved('invalid-git-dir');
  if (!ref.startsWith('refs/heads/')) return null;
  try {
    return utf8.decode(Buffer.from(ref.slice('refs/heads/'.length), 'latin1'));
  } catch {
    // Git allows ref names that are not valid UTF-8. The branch cannot be shown as text.
    return null;
  }
}

// The single path written in a .git file, commondir, or gitdir. Git strips the line ending.
function parseLinkFile(bytes: Buffer, prefix: string, invalid: RepositoryReason): string {
  let content: string;
  try {
    content = utf8.decode(bytes);
  } catch {
    throw new Unresolved(invalid);
  }
  content = content.replace(/\r?\n$/, '');
  if (!content.startsWith(prefix)) throw new Unresolved(invalid);
  const path = content.slice(prefix.length);
  if (path === '' || path.includes('\n') || path.includes('\0')) throw new Unresolved(invalid);
  return path;
}

type PathImpl = typeof posix;

interface CheckoutResolution {
  state: 'resolved' | 'unresolved';
  // resolved
  id?: string;
  nameSegments?: string[];
  checkout?: CheckoutInfo;
  // unresolved
  reason?: RepositoryReason;
}

export interface RepositoryDetectorOptions {
  fs?: RepositoryFs;
  platform?: 'posix' | 'win32';
  // Never look above this directory. Tests use it so a .git above the temporary directory does not change results.
  stopAt?: string;
}

export interface RepositoryDetector {
  detect(canonicalPath: string): Promise<Detection>;
}

// One detector serves one batch (an open, a refresh, a watch scan, or the daemon start).
// Results for the same directory are shared within the batch, including "no .git here".
export function createRepositoryDetector(
  options: RepositoryDetectorOptions = {},
): RepositoryDetector {
  const fs = options.fs ?? nodeRepositoryFs;
  const path: PathImpl = options.platform === 'win32' ? win32 : posix;
  const isWindows = options.platform === 'win32';
  const probes = new Map<string, Promise<EntryKind | 'absent' | 'error'>>();
  const checkouts = new Map<string, Promise<CheckoutResolution>>();

  const segmentsOf = (absolute: string) => absolute.split(path.sep).filter((part) => part !== '');
  const relativeSegments = (from: string, to: string) => segmentsOf(path.relative(from, to));

  // On Windows, paths taken from metadata must not reach another host (UNC) directly.
  // A path is allowed when its root is a drive letter or the same root as the document.
  const permits = (documentRoot: string, target: string) => {
    if (!isWindows) return true;
    const root = path.parse(target).root;
    if (/^[A-Za-z]:[\\/]$/.test(root)) return true;
    return root.toLowerCase() === documentRoot.toLowerCase();
  };
  const allowed = (documentRoot: string, target: string) => {
    if (!permits(documentRoot, target)) throw new Unresolved('blocked-path');
    return target;
  };

  const probe = (directory: string) => {
    let pending = probes.get(directory);
    if (!pending) {
      pending = fs.lstat(path.join(directory, '.git')).then(
        (kind) => kind,
        (error: NodeJS.ErrnoException) =>
          error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'absent' : 'error',
      );
      probes.set(directory, pending);
    }
    return pending;
  };

  const readMetadata = async (file: string, invalid: RepositoryReason) => {
    let bytes: Buffer | null;
    try {
      bytes = await fs.readSmall(file, METADATA_LIMIT);
    } catch (error) {
      throw failureOf(error, invalid);
    }
    if (bytes === null) throw new Unresolved('limit-exceeded');
    return bytes;
  };

  const realpathOf = async (target: string, invalid: RepositoryReason) => {
    try {
      return await fs.realpath(target);
    } catch (error) {
      throw failureOf(error, invalid);
    }
  };

  const expectDirectory = async (target: string) => {
    let kind: EntryKind;
    try {
      kind = await fs.stat(target);
    } catch (error) {
      throw failureOf(error, 'invalid-git-dir');
    }
    if (kind !== 'directory') throw new Unresolved('invalid-git-dir');
  };

  // A Git directory has a valid HEAD and the objects and refs directories. Returns the branch HEAD points to.
  // Checked once per directory in a batch (many documents can share one).
  const validated = new Map<string, Promise<string | null>>();
  const validateGitDir = (gitDir: string) => {
    let pending = validated.get(gitDir);
    if (!pending) {
      pending = (async () => {
        await expectDirectory(gitDir);
        const branch = parseHead(await readMetadata(path.join(gitDir, 'HEAD'), 'invalid-git-dir'));
        await expectDirectory(path.join(gitDir, 'objects'));
        await expectDirectory(path.join(gitDir, 'refs'));
        return branch;
      })();
      validated.set(gitDir, pending);
    }
    return pending;
  };

  const repositoryNameSegments = (commonDir: string) => {
    const segments = segmentsOf(commonDir);
    const last = segments.at(-1) ?? '';
    if (last === '.git') return segments.slice(0, -1);
    if (last.length > '.git'.length && last.endsWith('.git')) {
      return [...segments.slice(0, -1), last.slice(0, -'.git'.length)];
    }
    return segments;
  };

  // The checkout is the directory itself: its .git cannot be proven to belong to another repository.
  const standalone = (checkoutDir: string): CheckoutResolution => ({
    state: 'resolved',
    id: checkoutDir,
    nameSegments: segmentsOf(checkoutDir),
    checkout: { id: checkoutDir, kind: 'main' },
  });

  // The common Git directory named by <gitDir>/commondir (a linked worktree), or null when there is none.
  // A relative path is resolved from the Git directory, as Git does.
  const commonDirOf = async (gitDir: string, documentRoot: string): Promise<string | null> => {
    try {
      await fs.lstat(path.join(gitDir, 'commondir'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw failureOf(error, 'invalid-git-file');
    }
    const written = parseLinkFile(
      await readMetadata(path.join(gitDir, 'commondir'), 'invalid-git-file'),
      '',
      'invalid-git-file',
    );
    return realpathOf(allowed(documentRoot, path.resolve(gitDir, written)), 'invalid-git-dir');
  };

  // .git is a file: `gitdir: <path>`.
  const resolveGitFile = async (
    checkoutDir: string,
    gitFile: string,
    documentRoot: string,
  ): Promise<CheckoutResolution> => {
    const written = parseLinkFile(
      await readMetadata(gitFile, 'invalid-git-file'),
      'gitdir: ',
      'invalid-git-file',
    );
    // A relative path is resolved from the checkout, as Git does.
    const gitDir = await realpathOf(
      allowed(documentRoot, path.resolve(checkoutDir, written)),
      'invalid-git-file',
    );
    const commonDir = await commonDirOf(gitDir, documentRoot);
    if (commonDir === null) {
      // A submodule or --separate-git-dir. Without reading the Git configuration (core.worktree) there is no way
      // to check that this Git directory belongs to this checkout, so the checkout itself becomes the repository.
      await validateGitDir(gitDir);
      return standalone(checkoutDir);
    }
    // A linked worktree: <common git dir>/worktrees/<name>.
    await validateGitDir(commonDir);
    if (path.dirname(gitDir) !== path.join(commonDir, 'worktrees')) {
      throw new Unresolved('link-mismatch');
    }
    const branch = parseHead(await readMetadata(path.join(gitDir, 'HEAD'), 'invalid-git-dir'));
    // Git writes the path of the worktree's .git file back into the administrative directory.
    // A copied worktree, or a .git file pointing at another worktree's directory, does not match.
    const backWritten = parseLinkFile(
      await readMetadata(path.join(gitDir, 'gitdir'), 'link-mismatch'),
      '',
      'link-mismatch',
    );
    const back = allowed(documentRoot, path.resolve(gitDir, backWritten));
    if (path.basename(back) !== '.git') throw new Unresolved('link-mismatch');
    const backCheckout = await realpathOf(path.dirname(back), 'link-mismatch');
    if (backCheckout !== checkoutDir) throw new Unresolved('link-mismatch');
    return {
      state: 'resolved',
      id: commonDir,
      nameSegments: repositoryNameSegments(commonDir),
      checkout: { id: checkoutDir, kind: 'linked', name: path.basename(gitDir), branch },
    };
  };

  // .git is a symlink. Whatever it points to, the checkout itself becomes the repository:
  // a symlink can point at another repository's .git or another worktree's .git file.
  const resolveGitLink = async (
    checkoutDir: string,
    gitLink: string,
    documentRoot: string,
  ): Promise<CheckoutResolution> => {
    let target: string;
    try {
      target = allowed(documentRoot, path.resolve(checkoutDir, await fs.readlink(gitLink)));
    } catch (error) {
      throw failureOf(error, 'invalid-git-dir');
    }
    let kind: EntryKind;
    try {
      kind = await fs.lstat(target);
    } catch (error) {
      throw failureOf(error, 'invalid-git-dir');
    }
    if (kind === 'directory') {
      await validateGitDir(target);
      return standalone(checkoutDir);
    }
    if (kind === 'file') {
      const written = parseLinkFile(
        await readMetadata(target, 'invalid-git-file'),
        'gitdir: ',
        'invalid-git-file',
      );
      const gitDir = await realpathOf(
        allowed(documentRoot, path.resolve(checkoutDir, written)),
        'invalid-git-file',
      );
      // The file can be another worktree's .git, pointing at an administrative directory. That one has its own HEAD,
      // and its objects and refs live in the common Git directory.
      const common = await commonDirOf(gitDir, documentRoot);
      if (common === null) await validateGitDir(gitDir);
      else {
        await validateGitDir(common);
        parseHead(await readMetadata(path.join(gitDir, 'HEAD'), 'invalid-git-dir'));
      }
      return standalone(checkoutDir);
    }
    // A chain of symlinks, or another kind of entry.
    throw new Unresolved('invalid-git-dir');
  };

  const resolveCheckout = (
    checkoutDir: string,
    kind: EntryKind,
    documentRoot: string,
  ): Promise<CheckoutResolution> => {
    let pending = checkouts.get(checkoutDir);
    if (!pending) {
      const gitEntry = path.join(checkoutDir, '.git');
      const work = async (): Promise<CheckoutResolution> => {
        if (kind === 'directory') {
          await validateGitDir(gitEntry);
          return {
            state: 'resolved',
            id: gitEntry,
            nameSegments: repositoryNameSegments(gitEntry),
            checkout: { id: checkoutDir, kind: 'main' },
          };
        }
        if (kind === 'file') return resolveGitFile(checkoutDir, gitEntry, documentRoot);
        if (kind === 'symlink') return resolveGitLink(checkoutDir, gitEntry, documentRoot);
        throw new Unresolved('invalid-git-dir');
      };
      pending = work().catch((error: unknown) => ({
        state: 'unresolved',
        reason: failureOf(error, 'invalid-git-dir').reason,
      }));
      checkouts.set(checkoutDir, pending);
    }
    return pending;
  };

  const detect = async (canonicalPath: string): Promise<Detection> => {
    const documentRoot = path.parse(canonicalPath).root;
    let directory = path.dirname(canonicalPath);
    let kind: EntryKind;
    for (;;) {
      const found = await probe(directory);
      if (found === 'error') {
        return {
          state: 'unresolved',
          id: directory,
          nameSegments: segmentsOf(directory),
          pathInCheckout: relativeSegments(directory, canonicalPath),
          reason: 'unreadable',
        };
      }
      if (found !== 'absent') {
        kind = found;
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory || directory === options.stopAt) return { state: 'outside' };
      directory = parent;
    }

    const gitEntry = path.join(directory, '.git');
    // The document is inside the .git directory itself (a worktree removed while the document stayed open).
    if (kind === 'directory' && canonicalPath.startsWith(gitEntry + path.sep)) {
      try {
        await validateGitDir(gitEntry);
      } catch (error) {
        return {
          state: 'unresolved',
          id: directory,
          nameSegments: segmentsOf(directory),
          pathInCheckout: relativeSegments(directory, canonicalPath),
          reason: failureOf(error, 'invalid-git-dir').reason,
        };
      }
      return {
        state: 'resolved',
        id: gitEntry,
        nameSegments: repositoryNameSegments(gitEntry),
        checkout: null,
        pathInCheckout: relativeSegments(directory, canonicalPath),
      };
    }

    const resolution = await resolveCheckout(directory, kind, documentRoot);
    const pathInCheckout = relativeSegments(directory, canonicalPath);
    if (resolution.state === 'unresolved') {
      return {
        state: 'unresolved',
        id: directory,
        nameSegments: segmentsOf(directory),
        pathInCheckout,
        reason: resolution.reason ?? 'invalid-git-dir',
      };
    }
    return {
      state: 'resolved',
      id: resolution.id as string,
      nameSegments: resolution.nameSegments as string[],
      checkout: resolution.checkout as CheckoutInfo,
      pathInCheckout,
    };
  };

  return { detect };
}
