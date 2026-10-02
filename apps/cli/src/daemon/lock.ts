import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

const execFileAsync = promisify(execFile);

// lockは世代で管理する。`<name>.<世代>`のうち、世代が最大のfileが現在のlock。
// 次の世代のfileは排他的にしか作れないので、既存のlockを外さずに引き継げる。
// 解放は自分のfileを「解放済み」へ書き換えるだけで、消さない。
// 最大の世代のfileは誰も消さない。消されるのは、より新しい世代ができた後の古い世代だけ。
// したがって、消された世代を遅れて作り直しても、その時点で必ずより新しい世代が存在する。
// 取得は「作成できた」だけでは成立させず、自分が最大の世代であることを確かめてから成立させる。
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

// alive: 所有者が生きている。dead: 確実に停止している。
// 判定できない場合はaliveとして扱い、lockを引き継がない（仕様6.2）。
export type OwnerState = 'alive' | 'dead';

export interface ProcessProbe {
  isAlive(pid: number): boolean;
  // processの起動時刻。取得できなければnull。
  startTime(pid: number): Promise<Date | null>;
}

// lockを書いてからprocessが起動することはない。起動時刻がこれより後なら、PIDが再利用されている。
const START_TIME_TOLERANCE_MS = 2000;

export const systemProcessProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERMは「存在するが別ユーザーのprocess」。停止済みとは言えない。
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  },
  async startTime(pid) {
    if (process.platform === 'win32') return null;
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

// 現在のlock。無ければnull。読めないfileは'invalid'として、引き継ぎの対象にしない。
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
      // 一覧の後に、より新しい世代の所有者が古いfileを消した。一覧からやり直す。
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

// 内容を書き終えたfileを、排他的に指定の名前へ置く。既にあればfalse。
// 読む側が書きかけのlockを見ることはない。
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
    await rm(temp, { force: true });
  }
}

export type AcquireOutcome =
  | { acquired: true; info: LockInfo }
  | { acquired: false; reason: 'held' | 'invalid'; holder: LockInfo | null };

export interface AcquireHooks {
  // testで競合を再現するために、世代のfileを置く直前で待たせる。
  beforeLink?: (generation: number) => Promise<void>;
}

// lockを取得する。現在の所有者が生きていれば取得しない。
// 解放済み、または所有者が停止済みのときだけ、次の世代を排他的に作って引き継ぐ。
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
    // 同じ世代を別のprocessが先に作った。現在のlockを読み直して判定する。
    if (!created) continue;

    // 作成できても、観測が古かった場合がある（観測の後に世代が進み、この世代のfileが消されていた）。
    // 自分が最大の世代でなければ取得は成立していない。作ったfileを消して、判定をやり直す。
    const latest = (await listGenerations(directory, name)).at(-1);
    if (latest !== generation) {
      await rm(join(directory, fileNameOf(name, generation)), { force: true });
      continue;
    }
    // 自分より古い世代は、もう参照されない。
    for (const older of await listGenerations(directory, name)) {
      if (older < generation) await rm(join(directory, fileNameOf(name, older)), { force: true });
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

// 自分のlockを解放済みへ書き換える。fileは残すので、lockが存在しない瞬間はできない。
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
  await rename(temp, join(directory, fileNameOf(name, current.generation)));
}
