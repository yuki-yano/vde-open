import { fileURLToPath } from 'node:url';

// daemonのentry。配布物ではdist/daemon.js、sourceから実行するときはsrc/daemon.ts。
// 利用者のcwdやPATHではなく、このmoduleの位置から解決する。
export function daemonEntryPath(): string {
  const isSource = import.meta.url.endsWith('.ts');
  return fileURLToPath(new URL(isSource ? './daemon.ts' : './daemon.js', import.meta.url));
}
