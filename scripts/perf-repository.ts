// Measures repository detection the way the daemon runs it at start: one batch over every open document,
// with the daemon's limit on filesystem operations running at once. Prints JSON.
//   2,000 documents in one repository, spread over 200 directories.
//   2,000 documents outside any repository, each in its own directory 16 levels deep (every level is looked at).
// Each case runs 3 times on a fresh tracker (no cache between runs); the median is reported.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitDir } from '../apps/cli/src/documents/git.fixture.ts';
import { RepositoryTracker } from '../apps/cli/src/documents/repository-tracker.ts';

const DOCUMENTS = 2000;
const RUNS = 3;

const base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-perf-repository-')));

function inRepository(): string[] {
  const repo = join(base, 'repo');
  gitDir(join(repo, '.git'));
  const paths: string[] = [];
  for (let index = 0; index < DOCUMENTS; index += 1) {
    const directory = join(repo, 'docs', `dir-${String(index % 200).padStart(3, '0')}`);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `doc-${String(index).padStart(4, '0')}.md`);
    writeFileSync(path, '# doc\n');
    paths.push(path);
  }
  return paths;
}

function outside(): string[] {
  const paths: string[] = [];
  for (let index = 0; index < DOCUMENTS; index += 1) {
    const levels = Array.from({ length: 15 }, (_, level) => `l${String(level)}`);
    const directory = join(base, 'outside', `doc-${String(index).padStart(4, '0')}`, ...levels);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'a.md');
    writeFileSync(path, '# doc\n');
    paths.push(path);
  }
  return paths;
}

async function measure(paths: string[]): Promise<{ medianMs: number; runsMs: number[] }> {
  const runsMs: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const tracker = new RepositoryTracker({ waitMs: Number.POSITIVE_INFINITY });
    const started = performance.now();
    const batch = tracker.begin(paths);
    await batch.done;
    runsMs.push(Math.round((performance.now() - started) * 10) / 10);
    if (batch.results.size !== paths.length) throw new Error('Some documents were not detected.');
  }
  const sorted = [...runsMs].toSorted((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)] as number, runsMs };
}

try {
  const results = {
    environment: `${process.platform} ${process.arch}, Node.js ${process.version}`,
    inRepository: await measure(inRepository()),
    outsideDeep: await measure(outside()),
  };
  console.log(JSON.stringify(results, null, 2));
} finally {
  rmSync(base, { recursive: true, force: true });
}
