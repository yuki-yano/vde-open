#!/usr/bin/env node
import { fstatSync } from 'node:fs';

import { LIMITS, VdeError } from '@vde-open/shared';

import { runCli } from './cli/run.ts';
import { currentPathEnvironment } from './persistence/paths.ts';

// shellのpipe（FIFO）かredirect（通常file）で内容が渡されているときだけ、stdinを入力として扱う。
// Agentの実行環境ではstdinがsocketや/dev/nullになることがあり、それらは入力として扱わない。
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
      throw new VdeError('E_LIMIT_EXCEEDED', 'stdinの内容が1文書の大きさの上限を超えています。', {
        limit: 'documentBytes',
        max: LIMITS.documentBytes,
      });
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
