import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve, win32 } from 'node:path';

import { VdeError } from '@vde-open/shared';

export interface PathEnvironment {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  // POSIXのuid。Windowsではnull。
  uid: number | null;
}

const APP_DIR = 'vde-open';

// state rootは1ユーザーにつき1つ。VDE_OPEN_HOMEは試験と開発の分離にだけ使う（仕様6.1）。
export function resolveStateRoot(environment: PathEnvironment): string {
  const { env, platform, homeDir } = environment;
  const override = env['VDE_OPEN_HOME'];
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new VdeError('E_INVALID_ARGUMENT', 'VDE_OPEN_HOMEは絶対pathで指定してください。', {
        value: override,
      });
    }
    // 末尾や重複の区切りを正規化する。runtimeの位置はこのpathから決まる。
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
  // socketとIPC keyを置く所有者専用のdirectory。
  runtimeDir: string;
  // Unix domain socketのpath、またはWindowsのnamed pipe名。
  socketPath: string;
  keyPath: string;
}

// state rootが長くてもsocketのpath長制限に収まるよう、短い固定位置にhashで置く。
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
