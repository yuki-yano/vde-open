// daemonのentry。CLIから切り離して起動され、準備が終わったら親へ結果を1回だけ伝える。
import { isVdeError } from '@vde-open/shared';

import packageJson from '../package.json' with { type: 'json' };
import { startDaemon } from './daemon/main.ts';
import { currentPathEnvironment } from './persistence/paths.ts';

function notifyParent(message: Record<string, unknown>): void {
  if (!process.send) return;
  process.send(message, () => {
    // 親が待ち続けないよう、通知したら経路を閉じる。
    if (process.connected) process.disconnect();
  });
}

try {
  const daemon = await startDaemon({
    environment: currentPathEnvironment(),
    version: packageJson.version,
  });
  notifyParent({ type: 'ready', daemonId: daemon.daemonId });

  const shutdown = (signal: string) => void daemon.stop(signal);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  await daemon.stopped;
  process.exitCode = 0;
} catch (error) {
  notifyParent({
    type: 'error',
    code: isVdeError(error) ? error.code : 'E_DAEMON_START_FAILED',
    message: isVdeError(error) ? error.message : 'daemonを起動できませんでした。',
    details: isVdeError(error) ? error.details : {},
  });
  process.exitCode = 1;
}
