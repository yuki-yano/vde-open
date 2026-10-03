import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_LOG_BYTES = 1024 * 1024;

export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  log(event: string, fields?: LogFields): void;
  flush(): Promise<void>;
}

// Record only event names, counts, byte counts, error codes, and durations.
// Never pass bodies, answers, paths, or tokens (spec 10.6).
export function createFileLogger(stateRoot: string): Logger {
  const directory = join(stateRoot, 'logs');
  const file = join(directory, 'daemon.jsonl');
  let queue: Promise<void> = mkdir(directory, { recursive: true, mode: 0o700 }).then(
    () => undefined,
  );

  const write = async (line: string) => {
    try {
      const size = await stat(file).then(
        (stats) => stats.size,
        () => 0,
      );
      if (size + line.length > MAX_LOG_BYTES) await rename(file, `${file}.1`);
      await appendFile(file, line, { mode: 0o600 });
    } catch {
      // Even if the log cannot be written, the daemon keeps running.
    }
  };

  return {
    log(event, fields = {}) {
      const line = `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`;
      queue = queue.then(() => write(line));
    },
    flush() {
      return queue;
    },
  };
}
