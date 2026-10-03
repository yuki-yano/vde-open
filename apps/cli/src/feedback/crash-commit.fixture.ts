// Run as a child process by the SYS-009 test. During the commit of the given operation, kills the process
// without cleanup right before the Nth file operation. With 0, runs to the end and prints the list of file operations performed.
// Arguments: <state root> <kill at> <submit|create> <operation params as JSON>
//   submit: {requestId, params} (submits the saved draft answers; creates no new blob)
//   create: {cwd, questionnaire} (creates a question with no document; the question document's blob is created in the same commit)
import { randomBytes } from 'node:crypto';
import { sep } from 'node:path';

import { createCursorCodec } from '../documents/cursor.ts';
import { DocumentService } from '../documents/service.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs, type StoreFs } from '../persistence/store-fs.ts';
import { FeedbackService } from './service.ts';

const [root = '', crashAtText = '0', operation = '', paramsText = '{}'] = process.argv.slice(2);
const crashAt = Number(crashAtText);

// Target of a file operation: the blob directory itself (sync), a blob file, or anything else (state).
function kindOf(args: unknown[]): 'blob-dir' | 'blob' | 'state' {
  const paths = args.filter((arg): arg is string => typeof arg === 'string');
  if (paths.some((path) => path.endsWith(`${sep}blobs`))) return 'blob-dir';
  if (paths.some((path) => path.includes(`${sep}blobs${sep}`))) return 'blob';
  return 'state';
}

const performed: string[] = [];
let armed = false;
const fs = Object.fromEntries(
  Object.entries(nodeStoreFs).map(([name, run]) => [
    name,
    (...args: unknown[]) => {
      if (armed) {
        if (performed.length + 1 === crashAt) process.kill(process.pid, 'SIGKILL');
        performed.push(`${name}:${kindOf(args)}`);
      }
      return (run as (...a: unknown[]) => unknown)(...args);
    },
  ]),
) as unknown as StoreFs;

const store = await StateStore.open({ root, fs });
const documents = new DocumentService({ store, cursors: createCursorCodec(randomBytes(32)) });
const feedback = new FeedbackService({ store, documents });
const params = JSON.parse(paramsText) as Record<string, unknown>;
armed = true;
if (operation === 'submit') {
  await feedback.submit(params['requestId'] as string, params['params']);
} else if (operation === 'create') {
  await feedback.create(params);
} else {
  throw new Error(`Unknown operation: ${operation}`);
}
process.stdout.write(JSON.stringify(performed), () => process.exit(0));
