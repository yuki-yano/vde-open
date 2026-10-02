import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
    // 参照するblobがそろっているstateだけを、使えるstateとして扱う。
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

// state・runtime・lockを診断する。tokenや本文、回答は返さない（仕様5.5）。
// 修復は--repair --yesのときだけ行い、検証済みのbackupと、所有者が確実に停止済みのruntimeだけを扱う。
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
      message: `state rootが安全ではありません（${rootReason}）。`,
      repairable: false,
    });
    // 安全でないstate rootは変更しない。
    if (options.repair) {
      throw new VdeError('E_INSECURE_PATH', `${stateRoot} は安全ではないため、修復しません。`, {
        path: stateRoot,
        reason: rootReason,
      });
    }
  }

  // 安全でないstate root経由では、daemonへも接続しない。
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
      message: '停止済みdaemonのlockとruntimeが残っています。',
      repairable: true,
    });
  }
  if (!reachable && lock.state === 'owner-alive') {
    problems.push({
      code: 'E_DAEMON_LOCKED',
      message:
        'lockの所有者は生きていますが、daemonへ接続できません。所有者のprocessを確認してください。',
      repairable: false,
    });
  }
  if (lock.state === 'invalid') {
    problems.push({
      code: 'E_DAEMON_LOCKED',
      message: 'daemonのlockを読めません。',
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
          ? 'state.jsonを読めません。直前のstateへ戻せますが、最後の変更は失われます。'
          : 'state.jsonを読めず、検証済みのbackupもありません。',
      repairable: previousState.status === 'ok',
    });
  }
  if (state.status === 'unsupported') {
    problems.push({
      code: 'E_STATE_FORMAT_UNSUPPORTED',
      message:
        'stateは、より新しいversionのvde-openが作ったものです。そのversionを使ってください。',
      repairable: false,
    });
  }

  if (options.repair && rootSecure) {
    // daemonと同じwriter lockを取り、その内側で状態を確かめ直してから修復する。
    // lockを持っている間、daemonは起動できない。所有者が生きていれば取得できない。
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
          ? 'daemonのlockを読めないため、修復しません。'
          : 'daemonが動作中か、lockの所有者が生きています。停止してから修復してください。',
        { reason: outcome.reason },
      );
    }
    try {
      // lockを持っているので、残っているruntime fileはどのdaemonも使っていない。
      // 位置が所有者専用のdirectoryであることを確かめてから消す。
      const pointer = await readPointer(stateRoot);
      let removed = false;
      if (pointer) {
        await rm(join(stateRoot, POINTER_FILE), { force: true });
        removed = true;
      }
      if ((await inspectPrivateDirectory(location.runtimeDir, secure)) === 'ok') {
        for (const path of [
          ...(environment.platform === 'win32' ? [] : [location.socketPath]),
          location.keyPath,
        ]) {
          if ((await lstat(path).catch(() => null)) !== null) {
            await rm(path, { force: true });
            removed = true;
          }
        }
      }
      if (hadStaleOwner || removed) repairs.push('stale-runtime-removed');

      state = await inspectStateFile(stateRoot, 'state.json');
      previousState = await inspectStateFile(stateRoot, 'state.prev.json');
      if (isBroken(state, previousState) && previousState.status === 'ok') {
        const statePath = join(stateRoot, 'state.json');
        // 読めないstateは消さずに退避する。
        if (state.status !== 'missing') {
          await rename(statePath, join(stateRoot, `state.json.corrupt-${Date.now().toString()}`));
        }
        const temp = join(stateRoot, `.tmp-repair-${randomUUID()}`);
        await writeFile(temp, await readFile(join(stateRoot, 'state.prev.json')), { mode: 0o600 });
        await rename(temp, statePath);
        repairs.push('state-restored-from-backup');
        warnings.push({
          code: 'W_STATE_ROLLED_BACK',
          message:
            'stateを直前のbackupへ戻しました。最後に行った変更は失われている可能性があります。',
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
