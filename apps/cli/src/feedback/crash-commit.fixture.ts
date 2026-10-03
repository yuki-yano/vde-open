// SYS-009の試験で、子processとして実行する。指定した操作のcommitで、指定した番目のfile操作の直前に、
// 後始末をせずにprocessをkillする。0なら止めずに最後まで実行し、行ったfile操作の一覧を出力する。
// 引数: <state root> <止める番目> <submit|create> <操作のparamsのJSON>
//   submit: {requestId, params}（保存済みの回答案を送信する。新しいblobは作らない）
//   create: {cwd, questionnaire}（質問だけの質問を作る。質問の文書のblobを、質問と同じcommitで作る）
import { randomBytes } from 'node:crypto';
import { sep } from 'node:path';

import { createCursorCodec } from '../documents/cursor.ts';
import { DocumentService } from '../documents/service.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs, type StoreFs } from '../persistence/store-fs.ts';
import { FeedbackService } from './service.ts';

const [root = '', crashAtText = '0', operation = '', paramsText = '{}'] = process.argv.slice(2);
const crashAt = Number(crashAtText);

// file操作の対象。blobのdirectoryそのもの（sync）、blobのfile、それ以外（state）を区別する。
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
  throw new Error(`未知の操作: ${operation}`);
}
process.stdout.write(JSON.stringify(performed), () => process.exit(0));
