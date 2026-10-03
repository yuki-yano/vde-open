import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { removeWithRetry, renameWithRetry } from '../persistence/fs-retry.ts';
import { IPC_KEY_BYTES } from '../server/ipc-auth.ts';

// Prefix of the lock file name. The actual file is `<name>.<generation>` (lock.ts).
export const DAEMON_LOCK_NAME = 'daemon.lock';
export const START_LOCK_NAME = 'start.lock';
export const POINTER_FILE = 'runtime-pointer.json';

// Location of the runtime the daemon is actually using. Contains no secrets (spec 7.1).
const runtimePointerSchema = z.strictObject({
  daemonId: z.string().min(1),
  pid: z.number().int().positive(),
  protocolVersion: z.number().int(),
  version: z.string(),
  startedAt: z.string(),
  runtimeDir: z.string().min(1),
  socketPath: z.string().min(1),
  keyPath: z.string().min(1),
});
export type RuntimePointer = z.infer<typeof runtimePointerSchema>;

export async function readPointer(stateRoot: string): Promise<RuntimePointer | null> {
  try {
    return runtimePointerSchema.parse(
      JSON.parse(await readFile(join(stateRoot, POINTER_FILE), 'utf8')),
    );
  } catch {
    // A missing or unreadable pointer is treated as "no daemon". The connection target is verified by IPC authentication.
    return null;
  }
}

export async function writePointer(stateRoot: string, pointer: RuntimePointer): Promise<void> {
  const target = join(stateRoot, POINTER_FILE);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
  await renameWithRetry(temp, target);
}

export async function removePointer(stateRoot: string, daemonId: string): Promise<void> {
  const current = await readPointer(stateRoot);
  if (current?.daemonId === daemonId) await removeWithRetry(join(stateRoot, POINTER_FILE));
}

export async function createIpcKey(keyPath: string): Promise<Buffer> {
  const key = randomBytes(IPC_KEY_BYTES);
  await removeWithRetry(keyPath);
  await writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
  return key;
}

export async function readIpcKey(keyPath: string): Promise<Buffer | null> {
  try {
    const key = await readFile(keyPath);
    return key.byteLength === IPC_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}
