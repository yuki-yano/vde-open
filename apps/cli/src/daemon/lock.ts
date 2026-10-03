import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { removeWithRetry, renameWithRetry } from '../persistence/fs-retry.ts';

const execFileAsync = promisify(execFile);

// Locks are managed by generation. Among `<name>.<generation>` files, the highest generation is the current lock.
// The next generation's file can only be created exclusively, so a lock can be taken over without removing the existing one.
// Releasing only rewrites the owner's file as "released"; it does not delete it.
// Nobody deletes the file of the highest generation. Only older generations are deleted, after a newer one exists.
// Therefore, even if a deleted generation is recreated late, a newer generation always exists by then.
// Acquisition is not complete just because the file was created; it completes only after confirming this is the highest generation.
const GENERATION_DIGITS = 12;
const ACQUIRE_ATTEMPTS = 8;

const lockInfoSchema = z.strictObject({
  generation: z.number().int().positive(),
  pid: z.number().int().positive(),
  ownerId: z.string().min(1),
  startedAt: z.string(),
  released: z.boolean(),
});
export type LockInfo = z.infer<typeof lockInfoSchema>;

// alive: the owner is running. dead: it has definitely stopped.
// When undeterminable, treat it as alive and do not take over the lock (spec 6.2).
export type OwnerState = 'alive' | 'dead';

export interface ProcessProbe {
  isAlive(pid: number): boolean;
  // Start time of the process. null if unavailable.
  startTime(pid: number): Promise<Date | null>;
}

// A process never starts after its lock was written. If the start time is later than this, the PID has been reused.
const START_TIME_TOLERANCE_MS = 2000;

export const systemProcessProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means "exists but belongs to another user". It cannot be called dead.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  },
  async startTime(pid) {
    if (process.platform === 'win32') return windowsStartTime(pid);
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
      const parsed = new Date(stdout.trim());
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    } catch {
      return null;
    }
  },
};

// Windows has no `ps`. PowerShell reports the start time as an ISO 8601 string in UTC.
async function windowsStartTime(pid: number): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { timeout: 10_000, windowsHide: true },
    );
    const parsed = new Date(stdout.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

export async function inspectOwner(info: LockInfo, probe: ProcessProbe): Promise<OwnerState> {
  if (!probe.isAlive(info.pid)) return 'dead';
  const startedAt = Date.parse(info.startedAt);
  const processStart = await probe.startTime(info.pid);
  if (processStart && !Number.isNaN(startedAt)) {
    if (processStart.getTime() > startedAt + START_TIME_TOLERANCE_MS) return 'dead';
  }
  return 'alive';
}

function fileNameOf(name: string, generation: number): string {
  return `${name}.${String(generation).padStart(GENERATION_DIGITS, '0')}`;
}

async function listGenerations(directory: string, name: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const prefix = `${name}.`;
  const generations: number[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const suffix = entry.slice(prefix.length);
    if (/^\d+$/.test(suffix)) generations.push(Number(suffix));
  }
  return generations.toSorted((a, b) => a - b);
}

// The current lock. null if none. An unreadable file is 'invalid' and is not a takeover candidate.
export async function readCurrentLock(
  directory: string,
  name: string,
): Promise<LockInfo | 'invalid' | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generation = (await listGenerations(directory, name)).at(-1);
    if (generation === undefined) return null;
    let text: string;
    try {
      text = await readFile(join(directory, fileNameOf(name, generation)), 'utf8');
    } catch (error) {
      // After listing, the owner of a newer generation deleted the old file. Start over from the listing.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    try {
      const info = lockInfoSchema.parse(JSON.parse(text));
      return info.generation === generation ? info : 'invalid';
    } catch {
      return 'invalid';
    }
  }
  return 'invalid';
}

// Place a fully written file at the given name exclusively. Returns false if it already exists.
// Readers never see a partially written lock.
async function createExclusive(
  directory: string,
  fileName: string,
  info: LockInfo,
  beforeLink: (() => Promise<void>) | undefined,
): Promise<boolean> {
  const temp = join(directory, `.lock-tmp-${randomUUID()}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(info)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await beforeLink?.();
    await link(temp, join(directory, fileName));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await removeWithRetry(temp);
  }
}

export type AcquireOutcome =
  | { acquired: true; info: LockInfo }
  | { acquired: false; reason: 'held' | 'invalid'; holder: LockInfo | null };

export interface AcquireHooks {
  // Pauses right before placing the generation file, so tests can reproduce a race.
  beforeLink?: (generation: number) => Promise<void>;
}

// Acquire the lock. Does not acquire if the current owner is alive.
// Only when released or the owner is dead, create the next generation exclusively and take over.
export async function acquireLock(
  directory: string,
  name: string,
  owner: { pid: number; ownerId: string },
  probe: ProcessProbe,
  hooks: AcquireHooks = {},
): Promise<AcquireOutcome> {
  let holder: LockInfo | null = null;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const current = await readCurrentLock(directory, name);
    if (current === 'invalid') return { acquired: false, reason: 'invalid', holder: null };
    let generation = 1;
    if (current) {
      holder = current;
      if (!current.released && (await inspectOwner(current, probe)) === 'alive') {
        return { acquired: false, reason: 'held', holder: current };
      }
      generation = current.generation + 1;
    }
    const info: LockInfo = {
      generation,
      pid: owner.pid,
      ownerId: owner.ownerId,
      startedAt: new Date().toISOString(),
      released: false,
    };
    const beforeLink = hooks.beforeLink;
    const created = await createExclusive(
      directory,
      fileNameOf(name, generation),
      info,
      beforeLink ? () => beforeLink(generation) : undefined,
    );
    // Another process created the same generation first. Re-read the current lock and decide again.
    if (!created) continue;

    // Even if created, the observation may have been stale (the generation advanced after it, and this generation's file had been deleted).
    // If this is not the highest generation, acquisition did not complete. Delete the created file and decide again.
    const latest = (await listGenerations(directory, name)).at(-1);
    if (latest !== generation) {
      await removeWithRetry(join(directory, fileNameOf(name, generation)));
      continue;
    }
    // Generations older than ours are no longer referenced.
    for (const older of await listGenerations(directory, name)) {
      if (older < generation) await removeWithRetry(join(directory, fileNameOf(name, older)));
    }
    return { acquired: true, info };
  }
  return { acquired: false, reason: 'held', holder };
}

export async function holdsLock(
  directory: string,
  name: string,
  ownerId: string,
): Promise<boolean> {
  const current = await readCurrentLock(directory, name);
  return (
    current !== null && current !== 'invalid' && current.ownerId === ownerId && !current.released
  );
}

// Rewrite our own lock as released. The file is kept, so there is never a moment without a lock.
export async function releaseLock(directory: string, name: string, ownerId: string): Promise<void> {
  const current = await readCurrentLock(directory, name);
  if (!current || current === 'invalid' || current.ownerId !== ownerId || current.released) return;
  const temp = join(directory, `.lock-tmp-${randomUUID()}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ ...current, released: true })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameWithRetry(temp, join(directory, fileNameOf(name, current.generation)));
}
