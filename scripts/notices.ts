// 配布物へ入れた外部packageのlicense noticeを作る（仕様16.3、ADR-0001）。
// bundleしたmoduleの一覧（tsdown・viteのpluginが書く）から、packageを特定する。
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  // packageに含まれるlicense・notice・copyingのfile。
  files: Array<{ name: string; text: string }>;
}

// bundlerが出力へ入れるruntimeのcode。module idは仮想のもので、packageのpathを持たない。
const VIRTUAL_MODULES: Record<string, string> = {
  '\0rolldown/runtime.js': 'rolldown',
  '\0vite/modulepreload-polyfill.js': 'vite',
};

const NOTICE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

// module IDから、そのmoduleを含むpackageのdirectoryを求める。
// IDの区切りは、bundlerによって`/`（ViteはWindowsでも`/`へそろえる）か、OSの区切りになる。
// どちらも`/`へそろえて扱う（Nodeのfile操作は、Windowsでも`/`区切りのpathを受け付ける）。
export function packageDirOfModule(id: string): string | null {
  const normalized = id.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  const rest = normalized.slice(index + marker.length).split('/');
  const depth = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= depth) return null;
  return `${normalized.slice(0, index + marker.length)}${rest.slice(0, depth).join('/')}`;
}

export function readPackage(dir: string): BundledPackage {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    license?: string;
  };
  const files = readdirSync(dir)
    .filter((name) => NOTICE_FILE.test(name))
    .toSorted()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').trim() }));
  if (!manifest.name || !manifest.version)
    throw new Error(`${dir} のpackage.jsonに名前か版がありません`);
  if (!manifest.license && files.length === 0) {
    throw new Error(`${manifest.name} のlicenseが分かりません（package.jsonにもfileにもない）`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? '（package.jsonに記載なし）',
    files,
  };
}

// 名前からpackageのdirectoryを探す。rootsの順に、`<root>/<name>`を見る。
export function findPackageDir(name: string, roots: string[]): string {
  for (const root of roots) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  throw new Error(`${name} のpackageが見つかりません`);
}

// pnpmの配置で、あるpackageが依存するpackageを置いている場所（そのpackageの隣）。
export function siblingsOf(packageDir: string): string {
  const real = realpathSync(packageDir);
  const name = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as { name: string };
  return name.name.startsWith('@') ? dirname(dirname(real)) : dirname(real);
}

// module idの一覧から、bundleに入った外部packageを集める。
// virtualRootsは、仮想のmodule（bundlerのruntime）のpackageを探す場所。
export function packagesOfModules(ids: string[], virtualRoots: string[]): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const id of ids) {
    const virtual = VIRTUAL_MODULES[id];
    const dir =
      virtual !== undefined
        ? findPackageDir(virtual, virtualRoots)
        : id.startsWith('\0')
          ? null
          : packageDirOfModule(id);
    if (dir === null) continue;
    const real = realpathSync(dir);
    dirs.set(real, real);
  }
  return dirs;
}

export function renderNotices(packages: BundledPackage[]): string {
  const sorted = packages.toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  const lines = [
    '# Third-party notices',
    '',
    'vde-open（UNLICENSED）の配布物（`dist/`）には、次のpackageのcode・style・fontを含みます。',
    '各packageは、それぞれのlicenseに従います。この一覧は`pnpm build`がbundleの内容から作ります。',
    '',
  ];
  for (const item of sorted) {
    lines.push(`## ${item.name}@${item.version}`, '', `License: ${item.license}`, '');
    if (item.files.length === 0) {
      lines.push('（packageにlicenseのfileが含まれていません）', '');
    }
    for (const file of item.files) {
      // 本文に含まれる「`」の連続より長いfenceで囲む（本文がfenceを閉じないように）。
      const longest = Math.max(0, ...[...file.text.matchAll(/`+/g)].map((run) => run[0].length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      lines.push(`### ${file.name}`, '', `${fence}text`, file.text, fence, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
