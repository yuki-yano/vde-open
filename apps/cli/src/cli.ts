#!/usr/bin/env node
import { fstatSync } from 'node:fs';

import { LIMITS, VdeError } from '@vde-open/shared';

import { runCli } from './cli/run.ts';
import { currentPathEnvironment } from './persistence/paths.ts';

// Treat stdin as input only when content comes through a shell pipe (FIFO) or redirect (regular file).
// In agent environments stdin may be a socket or /dev/null, and those are not treated as input.
function stdinIsPiped(): boolean {
  try {
    const stats = fstatSync(0);
    return stats.isFIFO() || stats.isFile();
  } catch {
    return false;
  }
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = chunk as Buffer;
    size += bytes.byteLength;
    if (size > LIMITS.documentBytes) {
      throw new VdeError(
        'E_LIMIT_EXCEEDED',
        'The stdin content exceeds the size limit for one document.',
        {
          limit: 'documentBytes',
          max: LIMITS.documentBytes,
        },
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  environment: currentPathEnvironment(),
  stdoutIsTty: process.stdout.isTTY === true,
  stdin: { isPiped: stdinIsPiped(), read: readStdin },
});
