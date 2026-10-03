import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  IPC_PROTOCOL_VERSION,
  isVdeError,
  LIMITS,
  STATE_FORMAT_VERSION,
  VdeError,
  type Warning,
} from '@vde-open/shared';

import type { DaemonControl } from '../cli/daemon-control.ts';
import {
  acquireLock,
  inspectOwner,
  readCurrentLock,
  releaseLock,
  systemProcessProbe,
  type ProcessProbe,
} from '../daemon/lock.ts';
import { DAEMON_LOCK_NAME, POINTER_FILE, readPointer } from '../daemon/runtime-files.ts';
import { inspectPrivateDirectory } from '../daemon/secure-dir.ts';
import { removeWithRetry, renameWithRetry } from '../persistence/fs-retry.ts';
import { resolveRuntimeLocation, type PathEnvironment } from '../persistence/paths.ts';
import { referencedBlobs } from '../persistence/state-schema.ts';
import { decodeStateFile } from '../persistence/state-store.ts';

type FileStatus = 'ok' | 'missing' | 'corrupt' | 'unsupported';
type LockState = 'none' | 'owner-alive' | 'owner-stopped' | 'invalid';

interface StateFileReport {
  status: FileStatus;
  storeVersion: number | null;
  bytes: number | null;
  errorCode: string | null;
  detail: string | null;
}

interface Problem {
  code: string;
  message: string;
  repairable: boolean;
}

export interface DoctorReport {
  version: string;
  protocolVersion: number;
  stateFormatVersion: number;
  stateRoot: { path: string; exists: boolean; secure: boolean; reason: string | null };
  state: StateFileReport;
  previousState: StateFileReport;
  daemon: {
    reachable: boolean;
    lock: LockState;
    lockPid: number | null;
    pointer: boolean;
  };
  runtime: { path: string; exists: boolean };
  storage: { blobCount: number; blobBytes: number; blobLimitBytes: number };
  problems: Problem[];
  repairs: string[];
}

async function inspectStateFile(stateRoot: string, name: string): Promise<StateFileReport> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(stateRoot, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', storeVersion: null, bytes: null, errorCode: null, detail: null };
    }
    throw error;
  }
  try {
    const decoded = decodeStateFile(bytes, name);
    // Only a state whose referenced blobs are all present counts as usable.
    const blobs = new Set(await readdir(join(stateRoot, 'blobs')).catch(() => [] as string[]));
    for (const blob of referencedBlobs(decoded.payload)) {
      if (!blobs.has(blob)) {
        return {
          status: 'corrupt',
          storeVersion: decoded.storeVersion,
          bytes: bytes.byteLength,
          errorCode: 'E_STATE_CORRUPT',
          detail: 'missing-blob',
        };
      }
    }
    return {
      status: 'ok',
      storeVersion: decoded.storeVersion,
      bytes: bytes.byteLength,
      errorCode: null,
      detail: null,
    };
  } catch (error) {
    if (!isVdeError(error)) throw error;
    return {
      status: error.code === 'E_STATE_FORMAT_UNSUPPORTED' ? 'unsupported' : 'corrupt',
      storeVersion: null,
      bytes: bytes.byteLength,
      errorCode: error.code,
      detail: error.message,
    };
  }
}

function isBroken(state: StateFileReport, previous: StateFileReport): boolean {
  return (
    state.status === 'corrupt' || (state.status === 'missing' && previous.status !== 'missing')
  );
}

export interface DoctorOptions {
  environment: PathEnvironment;
  control: DaemonControl;
  version: string;
  repair: boolean;
  probe?: ProcessProbe;
}

export interface DoctorResult {
  report: DoctorReport;
  warnings: Warning[];
}

// Diagnoses state, runtime, and lock. Never returns tokens, document bodies, or answers (spec 5.5).
// Repairs run only with --repair --yes, and touch only a verified backup and a runtime whose owner is known to be stopped.
export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const { environment, control, version } = options;
  const probe = options.probe ?? systemProcessProbe;
  const stateRoot = control.stateRoot;
  const secure = { uid: environment.uid, platform: environment.platform };
  const warnings: Warning[] = [];
  const problems: Problem[] = [];
  const repairs: string[] = [];

  const rootInspection = await inspectPrivateDirectory(stateRoot, secure);
  const rootSecure = rootInspection === 'ok';
  const rootReason =
    rootInspection === 'ok' || rootInspection === 'missing' ? null : rootInspection;
  if (rootReason) {
    problems.push({
      code: 'E_INSECURE_PATH',
      message: `The state root is not secure (${rootReason}).`,
      repairable: false,
    });
    // Never modify an insecure state root.
    if (options.repair) {
      throw new VdeError(
        'E_INSECURE_PATH',
        `${stateRoot} is not secure, so it will not be repaired.`,
        {
          path: stateRoot,
          reason: rootReason,
        },
      );
    }
  }

  // Do not connect to the daemon through an insecure state root either.
  let reachable = false;
  if (rootSecure) {
    const connection = await control.connectExisting().catch(() => null);
    reachable = connection !== null;
    connection?.close();
  }

  const readLockState = async (): Promise<{ state: LockState; pid: number | null }> => {
    const lock = await readCurrentLock(stateRoot, DAEMON_LOCK_NAME);
    if (lock === 'invalid') return { state: 'invalid', pid: null };
    if (!lock || lock.released) return { state: 'none', pid: null };
    return {
      state: (await inspectOwner(lock, probe)) === 'alive' ? 'owner-alive' : 'owner-stopped',
      pid: lock.pid,
    };
  };
  let lock = await readLockState();

  const location = resolveRuntimeLocation(stateRoot, environment);
  if (!reachable && lock.state === 'owner-stopped') {
    problems.push({
      code: 'W_STALE_RUNTIME',
      message: 'The lock and runtime of a stopped daemon remain.',
      repairable: true,
    });
  }
  if (!reachable && lock.state === 'owner-alive') {
    problems.push({
      code: 'E_DAEMON_LOCKED',
      message:
        'The lock owner is alive, but the daemon cannot be reached. Check the owner process.',
      repairable: false,
    });
  }
  if (lock.state === 'invalid') {
    problems.push({
      code: 'E_DAEMON_LOCKED',
      message: 'The daemon lock cannot be read.',
      repairable: false,
    });
  }

  let state = await inspectStateFile(stateRoot, 'state.json');
  let previousState = await inspectStateFile(stateRoot, 'state.prev.json');
  if (isBroken(state, previousState)) {
    problems.push({
      code: 'E_STATE_CORRUPT',
      message:
        previousState.status === 'ok'
          ? 'state.json cannot be read. It can be rolled back to the previous state, but the last change will be lost.'
          : 'state.json cannot be read, and there is no verified backup.',
      repairable: previousState.status === 'ok',
    });
  }
  if (state.status === 'unsupported') {
    problems.push({
      code: 'E_STATE_FORMAT_UNSUPPORTED',
      message: 'The state was written by a newer version of vde-open. Use that version.',
      repairable: false,
    });
  }

  if (options.repair && rootSecure) {
    // Take the same writer lock as the daemon, re-check the state inside it, then repair.
    // While the lock is held, the daemon cannot start. It cannot be acquired while the owner is alive.
    const ownerId = `doctor_${randomUUID()}`;
    const hadStaleOwner = lock.state === 'owner-stopped';
    const outcome = await acquireLock(
      stateRoot,
      DAEMON_LOCK_NAME,
      { pid: process.pid, ownerId },
      probe,
    );
    if (!outcome.acquired) {
      throw new VdeError(
        'E_DAEMON_LOCKED',
        outcome.reason === 'invalid'
          ? 'The daemon lock cannot be read, so nothing will be repaired.'
          : 'The daemon is running, or the lock owner is alive. Stop it before repairing.',
        { reason: outcome.reason },
      );
    }
    try {
      // We hold the lock, so no daemon is using the remaining runtime files.
      // Confirm the location is an owner-only directory before removing them.
      const pointer = await readPointer(stateRoot);
      let removed = false;
      if (pointer) {
        await removeWithRetry(join(stateRoot, POINTER_FILE));
        removed = true;
      }
      if ((await inspectPrivateDirectory(location.runtimeDir, secure)) === 'ok') {
        for (const path of [
          ...(environment.platform === 'win32' ? [] : [location.socketPath]),
          location.keyPath,
        ]) {
          if ((await lstat(path).catch(() => null)) !== null) {
            await removeWithRetry(path);
            removed = true;
          }
        }
      }
      if (hadStaleOwner || removed) repairs.push('stale-runtime-removed');

      state = await inspectStateFile(stateRoot, 'state.json');
      previousState = await inspectStateFile(stateRoot, 'state.prev.json');
      if (isBroken(state, previousState) && previousState.status === 'ok') {
        const statePath = join(stateRoot, 'state.json');
        // Set the unreadable state aside instead of deleting it.
        if (state.status !== 'missing') {
          await renameWithRetry(
            statePath,
            join(stateRoot, `state.json.corrupt-${Date.now().toString()}`),
          );
        }
        const temp = join(stateRoot, `.tmp-repair-${randomUUID()}`);
        await writeFile(temp, await readFile(join(stateRoot, 'state.prev.json')), { mode: 0o600 });
        await renameWithRetry(temp, statePath);
        repairs.push('state-restored-from-backup');
        warnings.push({
          code: 'W_STATE_ROLLED_BACK',
          message:
            'The state was rolled back to the previous backup. The last change may have been lost.',
          details: { storeVersion: previousState.storeVersion },
        });
        state = await inspectStateFile(stateRoot, 'state.json');
      }
    } finally {
      await releaseLock(stateRoot, DAEMON_LOCK_NAME, ownerId);
    }
    lock = await readLockState();
  }

  let blobCount = 0;
  let blobBytes = 0;
  for (const name of await readdir(join(stateRoot, 'blobs')).catch(() => [] as string[])) {
    const size = await stat(join(stateRoot, 'blobs', name)).then(
      (stats) => stats.size,
      () => 0,
    );
    blobCount += 1;
    blobBytes += size;
  }

  return {
    report: {
      version,
      protocolVersion: IPC_PROTOCOL_VERSION,
      stateFormatVersion: STATE_FORMAT_VERSION,
      stateRoot: {
        path: stateRoot,
        exists: rootInspection !== 'missing',
        secure: rootSecure,
        reason: rootReason,
      },
      state,
      previousState,
      daemon: {
        reachable,
        lock: lock.state,
        lockPid: lock.pid,
        pointer: (await readPointer(stateRoot)) !== null,
      },
      runtime: {
        path: location.runtimeDir,
        exists: (await lstat(location.runtimeDir).catch(() => null)) !== null,
      },
      storage: { blobCount, blobBytes, blobLimitBytes: LIMITS.blobStoreBytes },
      problems,
      repairs,
    },
    warnings,
  };
}
