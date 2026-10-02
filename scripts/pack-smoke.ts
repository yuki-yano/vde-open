// 配布tarballを空のdirectoryへ導入し、両binを検証する（仕様14.4）。
// 実装済みの手順までを実行する。手順を足すときはここへ追加する。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { captureCommand, captureInstalledBin, cliDir, repoRoot, runNpm, runPnpm } from './lib.ts';

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

// 手順1: tarballを生成し、中身を検査する。
function packTarball(): string {
  if (!existsSync(join(cliDir, 'dist', 'cli.js'))) {
    fail('apps/cli/dist/cli.js がありません。先に pnpm build を実行してください。');
  }
  const artifactsDir = join(repoRoot, 'artifacts');
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });
  runPnpm(['pack', '--pack-destination', artifactsDir], { cwd: cliDir });
  const tarballs = readdirSync(artifactsDir).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) fail(`tarballが1つではありません: ${tarballs.join(', ')}`);
  const tarball = join(artifactsDir, tarballs[0] as string);

  const listing = captureCommand('tar', ['-tzf', tarball], { cwd: repoRoot });
  if (listing.status !== 0) fail(`tarballを読めません: ${listing.stderr}`);
  const entries = new Set(listing.stdout.split(/\r?\n/).filter(Boolean));
  for (const entry of [
    'package/package.json',
    'package/dist/cli.js',
    'package/dist/web/index.html',
  ]) {
    if (!entries.has(entry)) fail(`tarballに ${entry} がありません`);
  }
  for (const entry of entries) {
    if (entry.startsWith('package/src/') || entry.endsWith('.ts')) {
      fail(`tarballにsourceが含まれています: ${entry}`);
    }
  }
  return tarball;
}

function verifyInstalled(tarball: string, installDir: string): void {
  // 手順2: 空のdirectoryへtarballだけを導入する。registryへは問い合わせない。
  writeFileSync(join(installDir, 'package.json'), '{"private":true}\n');
  runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: installDir,
  });

  // binのshebangが、いま検証に使っているNodeを起動するようにする。
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env['PATH'] ?? ''}`,
  };
  const binDir = join(installDir, 'node_modules', '.bin');
  const runBin = (name: string, args: string[]): string => {
    const result = captureInstalledBin(binDir, name, args, { cwd: installDir, env });
    if (result.status !== 0) {
      fail(`${name} ${args.join(' ')} が exit ${String(result.status)}: ${result.stderr}`);
    }
    return result.stdout;
  };

  // 手順3（CLI-002）: 両名のversionとhelpが一致する。
  for (const args of [['--version'], ['--help']]) {
    const long = runBin('vde-open', args);
    const short = runBin('vo', args);
    if (long.trim() === '') fail(`vde-open ${args.join(' ')} の出力が空です`);
    if (long !== short) fail(`vde-open と vo の ${args.join(' ')} が一致しません`);
  }
}

function main(): void {
  const tarball = packTarball();
  // 空白と日本語を含むpathでも導入・起動できることを同時に確かめる。
  const installDir = mkdtempSync(join(tmpdir(), 'vde-open pack 検証-'));
  try {
    verifyInstalled(tarball, installDir);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
  console.log(`pack-smoke: PASS CLI-002 (${tarball})`);
}

try {
  main();
} catch (error) {
  // 後始末を終えてから終了させるため、process.exitは呼ばない。
  process.exitCode = 1;
  if (error instanceof SmokeFailure) {
    console.error(`pack-smoke: FAIL: ${error.message}`);
  } else {
    console.error('pack-smoke: FAIL');
    console.error(error);
  }
}
