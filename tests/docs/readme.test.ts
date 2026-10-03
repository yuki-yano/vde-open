import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const readme = readFileSync(`${repoRoot}README.md`, 'utf8');
const agentUsage = readFileSync(`${repoRoot}docs/agent-usage.md`, 'utf8');
const cli = `${repoRoot}apps/cli/src/cli.ts`;

// 削除した機能（作業group・tag・対象の指定）の名残。
const REMOVED = /--target|--tag|--group|\btags?\b|\bgroups?\b/i;

function help(args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, VDE_OPEN_HOME: '/nonexistent/vde-open-readme-test' },
  });
}

describe('UX-007 READMEとhelp', () => {
  it('READMEは、停止・状態の保存先・検索の範囲・HTMLの制限・名前の競合を説明する', () => {
    for (const section of [
      '## 導入',
      '## `vde-open`と`vo`',
      '## 検索の範囲',
      '## HTMLの表示の制限',
      '## Markdownの表示の制限',
      '## 状態の保存先と停止',
      '## 人への質問と回答',
      '## トラブルシュート',
      '## 検証した範囲',
    ]) {
      expect(readme).toContain(section);
    }
    expect(readme).toContain('vo daemon stop');
    expect(readme).toContain('いま開いている文書だけ');
    expect(readme).toContain('VDE_OPEN_HOME');
  });

  it('READMEとAgent向けの資料とhelpに、削除した機能の名残がない', () => {
    expect(readme).not.toMatch(REMOVED);
    expect(agentUsage).not.toMatch(REMOVED);
    for (const args of [[], ['open'], ['search'], ['read'], ['ask'], ['feedback'], ['daemon']]) {
      expect(help(args)).not.toMatch(REMOVED);
    }
  });
});

describe('UX-008 検証した範囲', () => {
  it('検証したOS・browserと、未検証の範囲を分けて書く', () => {
    const section = readme.slice(readme.indexOf('## 検証した範囲'));
    expect(section).toMatch(/macOS.*検証済み/);
    expect(section).toMatch(/Linux、Windows.*未検証/);
    expect(section).toMatch(/Chromium.*全件を検証済み/);
    expect(section).toMatch(/Firefox・WebKitのそれ以外.*未検証/);
  });
});
