import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitDir, worktree, writeFile } from './git.fixture.ts';
import {
  createLimiter,
  createRepositoryDetector,
  isValidRefName,
  limitRepositoryFs,
  nodeRepositoryFs,
  parseHead,
  type RepositoryFs,
} from './repository.ts';

// The temporary directory as written in Git files. On macOS it goes through the /var -> /private/var symlink.
let written: string;
// The same directory with symlinks resolved. Documents are always given as canonical paths.
let base: string;

beforeEach(() => {
  written = mkdtempSync(join(tmpdir(), 'vde-open-repo-'));
  base = realpathSync(written);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const segments = (path: string) => path.split(sep).filter((part) => part !== '');

const file = writeFile;

const detect = (path: string, fs?: RepositoryFs) =>
  createRepositoryDetector({ stopAt: base, ...(fs ? { fs } : {}) }).detect(path);

// Records every filesystem access.
const recording = (inner: RepositoryFs = nodeRepositoryFs) => {
  const calls: Array<[string, string]> = [];
  const fs: RepositoryFs = {
    lstat: (path) => (calls.push(['lstat', path]), inner.lstat(path)),
    stat: (path) => (calls.push(['stat', path]), inner.stat(path)),
    readlink: (path) => (calls.push(['readlink', path]), inner.readlink(path)),
    realpath: (path) => (calls.push(['realpath', path]), inner.realpath(path)),
    readSmall: (path, limit) => (calls.push(['readSmall', path]), inner.readSmall(path, limit)),
  };
  return { fs, calls };
};

describe('repository detection', () => {
  it('finds the main checkout of an ordinary repository', async () => {
    const repo = join(base, 'repos', 'vde-open');
    gitDir(join(repo, '.git'));
    const document = file(join(repo, 'docs', 'design.md'), '# Design');

    expect(await detect(document)).toEqual({
      state: 'resolved',
      id: join(repo, '.git'),
      nameSegments: segments(repo),
      checkout: { id: repo, kind: 'main' },
      pathInCheckout: ['docs', 'design.md'],
    });
  });

  it('groups a vw worktree under .git/wt with its repository', async () => {
    const repo = join(base, 'duel-logger');
    gitDir(join(repo, '.git'));
    const checkout = join(repo, '.git', 'wt', 'investigate', 'local-auth');
    worktree(join(written, 'duel-logger', '.git'), checkout, 'local-auth', {
      head: 'ref: refs/heads/investigate/local-auth\n',
    });
    const document = file(join(checkout, 'docs', 'plan.md'), '# Plan');

    expect(await detect(document)).toEqual({
      state: 'resolved',
      id: join(repo, '.git'),
      nameSegments: segments(repo),
      checkout: {
        id: checkout,
        kind: 'linked',
        name: 'local-auth',
        branch: 'investigate/local-auth',
      },
      pathInCheckout: ['docs', 'plan.md'],
    });
  });

  it('has no branch for a detached HEAD, and keeps the worktree name', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const checkout = join(base, 'repo-x');
    worktree(join(repo, '.git'), checkout, 'x', { head: `${'a'.repeat(40)}\n` });

    expect(await detect(file(join(checkout, 'a.md'), 'a'))).toMatchObject({
      state: 'resolved',
      checkout: { id: checkout, kind: 'linked', name: 'x', branch: null },
    });
  });

  it('resolves relative gitdir, commondir, and back-link paths like absolute ones', async () => {
    const repo = join(base, 'plain');
    gitDir(join(repo, '.git'));
    const checkout = join(base, 'plain-wt');
    worktree(join(repo, '.git'), checkout, 'plain-wt', { relativePaths: true });

    expect(await detect(file(join(checkout, 'a.md'), 'a'))).toMatchObject({
      state: 'resolved',
      id: join(repo, '.git'),
      checkout: { id: checkout, kind: 'linked', name: 'plain-wt', branch: 'plain-wt' },
    });
  });

  it('accepts the fixed HEAD of a reftable repository without a branch', async () => {
    const repo = join(base, 'rt');
    gitDir(join(repo, '.git'), 'ref: refs/heads/.invalid\n');
    const checkout = join(base, 'rt-wt');
    worktree(join(repo, '.git'), checkout, 'rt-wt', { head: 'ref: refs/heads/.invalid\n' });

    expect(await detect(file(join(repo, 'a.md'), 'a'))).toMatchObject({ state: 'resolved' });
    expect(await detect(file(join(checkout, 'a.md'), 'a'))).toMatchObject({
      state: 'resolved',
      checkout: { kind: 'linked', name: 'rt-wt', branch: null },
    });
  });

  it('keeps worktrees of different bare repositories apart and names them without .git', async () => {
    const alpha = gitDir(join(base, 'owner', 'alpha.git'));
    const beta = gitDir(join(base, 'owner', 'beta.git'));
    worktree(alpha, join(base, 'work', 'alpha-main'), 'main');
    worktree(beta, join(base, 'work', 'beta-main'), 'main');

    const a = await detect(file(join(base, 'work', 'alpha-main', 'a.md'), 'a'));
    const b = await detect(file(join(base, 'work', 'beta-main', 'b.md'), 'b'));
    expect(a).toMatchObject({ state: 'resolved', id: alpha });
    expect(b).toMatchObject({ state: 'resolved', id: beta });
    expect(a.state === 'resolved' && a.nameSegments.at(-1)).toBe('alpha');
    expect(b.state === 'resolved' && b.nameSegments.at(-1)).toBe('beta');
  });

  it('makes a submodule its own repository, named after its directory', async () => {
    const parent = join(base, 'parent');
    gitDir(join(parent, '.git'));
    gitDir(join(parent, '.git', 'modules', 'sub'));
    const sub = join(parent, 'vendor', 'sub');
    file(join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n');

    expect(await detect(file(join(sub, 'README.md'), 'r'))).toEqual({
      state: 'resolved',
      id: sub,
      nameSegments: segments(sub),
      checkout: { id: sub, kind: 'main' },
      pathInCheckout: ['README.md'],
    });
  });

  it('does not join the repository a commondir-less .git file points to', async () => {
    const trusted = join(base, 'trusted');
    gitDir(join(trusted, '.git'));
    const evil = join(base, 'evil');
    file(join(evil, '.git'), `gitdir: ${join(trusted, '.git')}\n`);

    expect(await detect(file(join(evil, 'a.md'), 'a'))).toMatchObject({
      state: 'resolved',
      id: evil,
      checkout: { id: evil, kind: 'main' },
    });
  });

  it('places a document inside the .git directory in the repository with no checkout', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    // The worktree was removed while the document stayed open: its .git file is gone.
    const document = join(repo, '.git', 'wt', 'feature', 'x', 'docs', 'a.md');

    expect(await detect(document)).toEqual({
      state: 'resolved',
      id: join(repo, '.git'),
      nameSegments: segments(repo),
      checkout: null,
      pathInCheckout: ['.git', 'wt', 'feature', 'x', 'docs', 'a.md'],
    });
  });

  it('reports a file outside any repository', async () => {
    expect(await detect(file(join(base, 'notes', 'plan.md'), 'p'))).toEqual({ state: 'outside' });
  });

  it('walks through directories that no longer exist (a missing document)', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    expect(await detect(join(repo, 'gone', 'deeper', 'a.md'))).toMatchObject({
      state: 'resolved',
      pathInCheckout: ['gone', 'deeper', 'a.md'],
    });
  });

  describe('a .git symlink makes the checkout its own repository', () => {
    it('when it points at another repository .git directory', async () => {
      const trusted = join(base, 'trusted');
      gitDir(join(trusted, '.git'));
      const evil = join(base, 'evil');
      mkdirSync(evil);
      symlinkSync(join(trusted, '.git'), join(evil, '.git'));

      expect(await detect(file(join(evil, 'a.md'), 'a'))).toMatchObject({
        state: 'resolved',
        id: evil,
        checkout: { id: evil, kind: 'main' },
      });
    });

    it('when it points at another worktree .git file', async () => {
      const repo = join(base, 'trusted');
      gitDir(join(repo, '.git'));
      const checkout = join(base, 'trusted-wt');
      worktree(join(repo, '.git'), checkout, 'trusted-wt');
      const evil = join(base, 'evil');
      mkdirSync(evil);
      symlinkSync(join(checkout, '.git'), join(evil, '.git'));

      expect(await detect(file(join(evil, 'a.md'), 'a'))).toMatchObject({
        state: 'resolved',
        id: evil,
        checkout: { id: evil, kind: 'main' },
      });
    });

    it('and rejects a chain of symlinks', async () => {
      const repo = join(base, 'repo');
      gitDir(join(repo, '.git'));
      const evil = join(base, 'evil');
      mkdirSync(evil);
      symlinkSync(join(repo, '.git'), join(base, 'hop'));
      symlinkSync(join(base, 'hop'), join(evil, '.git'));

      expect(await detect(file(join(evil, 'a.md'), 'a'))).toMatchObject({
        state: 'unresolved',
        reason: 'invalid-git-dir',
      });
    });
  });

  describe('unresolved checkouts never fall back to a parent repository', () => {
    const parentRepo = () => {
      const parent = join(base, 'parent');
      gitDir(join(parent, '.git'));
      return parent;
    };

    it.each([
      [
        'a broken .git file',
        (dir: string) => file(join(dir, '.git'), 'not a gitfile\n'),
        'invalid-git-file',
      ],
      ['an empty .git directory', (dir: string) => mkdirSync(join(dir, '.git')), 'invalid-git-dir'],
      [
        'an invalid HEAD',
        (dir: string) => gitDir(join(dir, '.git'), 'ref: refs/heads/a..b\n'),
        'invalid-git-dir',
      ],
      [
        'missing objects',
        (dir: string) => {
          gitDir(join(dir, '.git'));
          rmSync(join(dir, '.git', 'objects'), { recursive: true });
        },
        'invalid-git-dir',
      ],
      [
        'a .git file pointing at a directory that is not Git',
        (dir: string) => {
          mkdirSync(join(dir, 'plain'));
          file(join(dir, '.git'), 'gitdir: plain\n');
        },
        'invalid-git-dir',
      ],
      [
        'a .git file pointing at a missing directory',
        (dir: string) => file(join(dir, '.git'), 'gitdir: nowhere\n'),
        'invalid-git-file',
      ],
      [
        'a HEAD larger than the limit',
        (dir: string) => gitDir(join(dir, '.git'), `ref: refs/heads/${'a'.repeat(5000)}\n`),
        'limit-exceeded',
      ],
    ])('%s', async (_label, build, reason) => {
      const parent = parentRepo();
      const child = join(parent, 'child');
      mkdirSync(child, { recursive: true });
      build(child);

      expect(await detect(file(join(child, 'a.md'), 'a'))).toEqual({
        state: 'unresolved',
        id: child,
        nameSegments: segments(child),
        pathInCheckout: ['a.md'],
        reason,
      });
    });

    it('a .git file pointing at another worktree administrative directory', async () => {
      const repo = join(base, 'repo');
      gitDir(join(repo, '.git'));
      const admin = worktree(join(repo, '.git'), join(base, 'real-wt'), 'real-wt');
      const evil = join(base, 'evil');
      file(join(evil, '.git'), `gitdir: ${admin}\n`);

      expect(await detect(file(join(evil, 'a.md'), 'a'))).toMatchObject({
        state: 'unresolved',
        id: evil,
        reason: 'link-mismatch',
      });
    });

    it('a worktree copied with cp -r', async () => {
      const repo = join(base, 'repo');
      gitDir(join(repo, '.git'));
      worktree(join(repo, '.git'), join(base, 'wt'), 'wt');
      file(join(base, 'wt', 'a.md'), 'a');
      execFileSync('cp', ['-R', join(base, 'wt'), join(base, 'copy')]);

      expect(await detect(join(base, 'wt', 'a.md'))).toMatchObject({ state: 'resolved' });
      expect(await detect(join(base, 'copy', 'a.md'))).toMatchObject({
        state: 'unresolved',
        id: join(base, 'copy'),
        reason: 'link-mismatch',
      });
    });

    it('a HEAD that is a symlink, even to a valid HEAD', async () => {
      const repo = join(base, 'repo');
      gitDir(join(repo, '.git'));
      writeFile(join(base, 'elsewhere', 'HEAD'), 'ref: refs/heads/main\n');
      rmSync(join(repo, '.git', 'HEAD'));
      symlinkSync(join(base, 'elsewhere', 'HEAD'), join(repo, '.git', 'HEAD'));
      const { fs, calls } = recording();

      expect(await detect(file(join(repo, 'a.md'), 'a'), fs)).toMatchObject({
        state: 'unresolved',
        reason: 'invalid-git-dir',
      });
      // Rejected by its type before it is opened.
      expect(calls).toContainEqual(['readSmall', join(repo, '.git', 'HEAD')]);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'a HEAD that cannot be read',
      async () => {
        const repo = join(base, 'repo');
        gitDir(join(repo, '.git'));
        chmodSync(join(repo, '.git', 'HEAD'), 0o000);
        try {
          expect(await detect(file(join(repo, 'a.md'), 'a'))).toMatchObject({
            state: 'unresolved',
            reason: 'unreadable',
          });
        } finally {
          chmodSync(join(repo, '.git', 'HEAD'), 0o600);
        }
      },
    );

    it.skipIf(process.platform === 'win32')(
      'a FIFO HEAD, without blocking',
      async () => {
        const repo = join(base, 'repo');
        gitDir(join(repo, '.git'));
        rmSync(join(repo, '.git', 'HEAD'));
        execFileSync('mkfifo', [join(repo, '.git', 'HEAD')]);

        expect(await detect(file(join(repo, 'a.md'), 'a'))).toMatchObject({
          state: 'unresolved',
          reason: 'invalid-git-dir',
        });
      },
      5000,
    );
  });

  it('matches the layout real Git writes for a worktree', async () => {
    const repo = join(base, 'real');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        stdio: 'ignore',
      });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', '-b', 'feature/x', join(repo, '.git', 'wt', 'feature', 'x'));

    expect(await detect(file(join(repo, '.git', 'wt', 'feature', 'x', 'a.md'), 'a'))).toMatchObject(
      {
        state: 'resolved',
        id: join(repo, '.git'),
        checkout: { kind: 'linked', name: 'x', branch: 'feature/x' },
      },
    );
    expect(await detect(file(join(repo, 'b.md'), 'b'))).toMatchObject({
      state: 'resolved',
      id: join(repo, '.git'),
      checkout: { id: repo, kind: 'main' },
    });
  });

  it('reads only the .git file, commondir, HEAD, and gitdir', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const checkout = join(base, 'wt');
    worktree(join(repo, '.git'), checkout, 'wt', { relativePaths: true });
    const { fs, calls } = recording();
    const detector = createRepositoryDetector({ fs, stopAt: base });
    await detector.detect(file(join(checkout, 'docs', 'a.md'), 'a'));
    await detector.detect(file(join(repo, 'b.md'), 'b'));

    const read = calls
      .filter(([op]) => op === 'readSmall')
      .map(([, path]) => path.split(sep).at(-1));
    expect(new Set(read)).toEqual(new Set(['.git', 'commondir', 'HEAD', 'gitdir']));
  });

  it('looks at each directory once within a detector', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const { fs, calls } = recording();
    const detector = createRepositoryDetector({ fs, stopAt: base });
    const documents = Array.from({ length: 1000 }, (_, index) =>
      join(repo, 'docs', `d${String(index)}.md`),
    );
    const results = await Promise.all(documents.map((document) => detector.detect(document)));

    expect(results.every((result) => result.state === 'resolved')).toBe(true);
    const lstats = calls.filter(([op]) => op === 'lstat').map(([, path]) => path);
    expect(lstats.length).toBe(new Set(lstats).size);
    expect(lstats).toEqual([join(repo, 'docs', '.git'), join(repo, '.git')]);
  });
});

describe('paths on Windows', () => {
  // A filesystem that only knows a few entries, using Windows paths.
  const fakeFs = (files: Record<string, string>, directories: string[]) => {
    const { fs, calls } = recording({
      lstat: async (path) => {
        if (path in files) return 'file';
        if (directories.includes(path)) return 'directory';
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      stat: async (path) => {
        if (path in files) return 'file';
        if (directories.includes(path)) return 'directory';
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      readlink: () => Promise.reject(new Error('not a link')),
      realpath: async (path) => {
        if (path in files || directories.includes(path)) return path;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      readSmall: async (path) => {
        const content = files[path];
        if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return Buffer.from(content);
      },
    });
    return { fs, calls };
  };
  const gitDirEntries = (dir: string) => ({
    files: { [`${dir}\\HEAD`]: 'ref: refs/heads/main\n' },
    directories: [dir, `${dir}\\objects`, `${dir}\\refs`],
  });

  it.each([
    '\\\\host\\share\\repo\\.git',
    '\\\\?\\UNC\\host\\share\\repo\\.git',
    '\\\\.\\pipe\\repo',
    '\\\\?\\Volume{0}\\repo\\.git',
  ])('does not touch a gitdir of %s', async (target) => {
    const { fs, calls } = fakeFs({ 'C:\\work\\wt\\.git': `gitdir: ${target}\n` }, ['C:\\work\\wt']);
    const detector = createRepositoryDetector({ fs, platform: 'win32' });

    expect(await detector.detect('C:\\work\\wt\\a.md')).toMatchObject({
      state: 'unresolved',
      id: 'C:\\work\\wt',
      reason: 'blocked-path',
    });
    // Nothing under the blocked path was accessed.
    expect(calls.filter(([, path]) => !path.startsWith('C:\\'))).toEqual([]);
  });

  it('cannot resolve a worktree written by WSL Git', async () => {
    // A rooted path without a drive takes the document's drive (C:\mnt\c\...), which does not exist.
    const { fs } = fakeFs({ 'C:\\work\\wt\\.git': 'gitdir: /mnt/c/repo/.git/worktrees/wt\n' }, [
      'C:\\work\\wt',
    ]);
    const detector = createRepositoryDetector({ fs, platform: 'win32' });

    expect(await detector.detect('C:\\work\\wt\\a.md')).toMatchObject({
      state: 'unresolved',
      reason: 'invalid-git-file',
    });
  });

  it('does not follow a commondir on another host', async () => {
    const admin = 'C:\\repo\\.git\\worktrees\\wt';
    const { fs, calls } = fakeFs(
      {
        'C:\\work\\wt\\.git': `gitdir: ${admin}\n`,
        [`${admin}\\commondir`]: '\\\\host\\share\\repo\\.git\n',
      },
      ['C:\\work\\wt', admin],
    );
    const detector = createRepositoryDetector({ fs, platform: 'win32' });

    expect(await detector.detect('C:\\work\\wt\\a.md')).toMatchObject({ reason: 'blocked-path' });
    expect(calls.filter(([, path]) => path.startsWith('\\\\'))).toEqual([]);
  });

  it('allows metadata on the same share as the document, and other drives', async () => {
    const share = '\\\\host\\share\\';
    const common = gitDirEntries(`${share}repo\\.git`);
    const admin = `${share}repo\\.git\\worktrees\\wt`;
    const { fs } = fakeFs(
      {
        ...common.files,
        [`${share}wt\\.git`]: `gitdir: ${admin}\n`,
        [`${admin}\\commondir`]: '..\\..\n',
        [`${admin}\\HEAD`]: 'ref: refs/heads/wt\n',
        [`${admin}\\gitdir`]: `${share}wt\\.git\n`,
        'C:\\d\\.git': 'gitdir: D:\\git\\d\n',
        ...gitDirEntries('D:\\git\\d').files,
      },
      [...common.directories, `${share}wt`, admin, ...gitDirEntries('D:\\git\\d').directories],
    );
    const detector = createRepositoryDetector({ fs, platform: 'win32' });

    expect(await detector.detect(`${share}wt\\a.md`)).toMatchObject({
      state: 'resolved',
      id: `${share}repo\\.git`,
      nameSegments: ['host', 'share', 'repo'],
      checkout: { kind: 'linked', name: 'wt', branch: 'wt' },
    });
    expect(await detector.detect('C:\\d\\a.md')).toMatchObject({ state: 'resolved', id: 'C:\\d' });
  });
});

describe('HEAD and ref names', () => {
  it.each([
    ['ref: refs/heads/main\n', 'main'],
    ['ref: refs/heads/feature/x\r\n', 'feature/x'],
    ['ref:refs/heads/main', 'main'],
    [`${'0'.repeat(64)}\n`, null],
    ['ref: refs/remotes/origin/main\n', null],
    ['ref: refs/heads/.invalid\n', null],
    // Git allows bidirectional controls in names. They stay in the data; the UI makes them harmless.
    ['ref: refs/heads/a\u202eb\n', 'a\u202eb'],
  ])('%j -> %j', (content, branch) => {
    expect(parseHead(Buffer.from(content))).toBe(branch);
  });

  it('has no branch for a name that is not UTF-8', () => {
    expect(parseHead(Buffer.from([...Buffer.from('ref: refs/heads/'), 0xff, 0x0a]))).toBeNull();
  });

  it.each([
    'ref: refs/heads/a b',
    'ref: refs/heads/a\u0001b',
    'ref: refs/heads/.hidden',
    'ref: refs/heads/x.lock',
    'ref: refs/heads/a//b',
    'ref: HEAD',
    'garbage',
    'a'.repeat(40) + 'x',
  ])('rejects %j', (content) => {
    expect(() => parseHead(Buffer.from(content))).toThrow();
  });

  it('follows git check-ref-format', () => {
    expect(isValidRefName('refs/heads/feature/x')).toBe(true);
    expect(isValidRefName('refs/heads/a@{b')).toBe(false);
    expect(isValidRefName('refs/heads/a~b')).toBe(false);
    expect(isValidRefName('refs/heads/end.')).toBe(false);
    expect(isValidRefName('@')).toBe(false);
  });
});

describe('the operation limit', () => {
  it('never runs more than the limit, and keeps the slots of stuck operations', async () => {
    const limiter = createLimiter(2);
    const release: Array<() => void> = [];
    let started = 0;
    const stuck = () =>
      limiter.run(
        () =>
          new Promise<void>((resolveStuck) => {
            started += 1;
            release.push(resolveStuck);
          }),
      );
    const first = stuck();
    const second = stuck();
    const third = stuck();
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    expect(started).toBe(2);
    expect(limiter.active).toBe(2);

    release[0]?.();
    await first;
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    expect(started).toBe(3);
    expect(limiter.active).toBe(2);
    release[1]?.();
    release[2]?.();
    await Promise.all([second, third]);
    expect(limiter.active).toBe(0);
  });

  it('applies to every filesystem operation of detection', async () => {
    const repo = join(base, 'repo');
    gitDir(join(repo, '.git'));
    const limiter = createLimiter(2);
    let peak = 0;
    const { fs } = recording();
    const watched: RepositoryFs = Object.fromEntries(
      Object.entries(fs).map(([name, operation]) => [
        name,
        async (...args: [string, number]) => {
          peak = Math.max(peak, limiter.active);
          return (operation as (...input: [string, number]) => Promise<unknown>)(...args);
        },
      ]),
    ) as unknown as RepositoryFs;
    const detector = createRepositoryDetector({
      fs: limitRepositoryFs(watched, limiter),
      stopAt: base,
    });
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        detector.detect(join(repo, `d${String(index)}`, 'a.md')),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});
