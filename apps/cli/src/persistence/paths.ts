import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve, win32 } from 'node:path';

import { VdeError } from '@vde-open/shared';

export interface PathEnvironment {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  // POSIX uid. null on Windows.
  uid: number | null;
}

const APP_DIR = 'vde-open';

// One state root per user. VDE_OPEN_HOME is used only to separate tests and development (spec 6.1).
export function resolveStateRoot(environment: PathEnvironment): string {
  const { env, platform, homeDir } = environment;
  const override = env['VDE_OPEN_HOME'];
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new VdeError('E_INVALID_ARGUMENT', 'VDE_OPEN_HOME must be an absolute path.', {
        value: override,
      });
    }
    // Normalize trailing and duplicate separators. The runtime location is derived from this path.
    return resolve(override);
  }
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', APP_DIR);
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    return win32.join(localAppData || win32.join(homeDir, 'AppData', 'Local'), APP_DIR);
  }
  const xdgState = env['XDG_STATE_HOME'];
  if (xdgState && isAbsolute(xdgState)) return join(xdgState, APP_DIR);
  return join(homeDir, '.local', 'state', APP_DIR);
}

export interface RuntimeLocation {
  // Owner-only directory that holds the socket and the IPC key.
  runtimeDir: string;
  // Path of the Unix domain socket, or the named pipe name on Windows.
  socketPath: string;
  keyPath: string;
}

// Place it at a short fixed location keyed by hash so a long state root still fits the socket path length limit.
export function resolveRuntimeLocation(
  stateRoot: string,
  environment: PathEnvironment,
): RuntimeLocation {
  const hash = createHash('sha256').update(stateRoot).digest('hex').slice(0, 16);
  if (environment.platform === 'win32') {
    const runtimeDir = win32.join(stateRoot, 'runtime');
    return {
      runtimeDir,
      socketPath: `\\\\.\\pipe\\vde-open-${hash}`,
      keyPath: win32.join(runtimeDir, 'ipc.key'),
    };
  }
  const uid = environment.uid ?? 0;
  const runtimeDir = join('/tmp', `vde-open-${String(uid)}`, hash);
  return {
    runtimeDir,
    socketPath: join(runtimeDir, 'ipc.sock'),
    keyPath: join(runtimeDir, 'ipc.key'),
  };
}

export function currentPathEnvironment(): PathEnvironment {
  return {
    env: process.env,
    platform: process.platform,
    homeDir: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  };
}
