import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string) => readFileSync(`${repoRoot}${path}`, 'utf8');
const readme = read('README.md');
const readmeJa = read('README.ja.md');
const agentUsage = read('docs/agent-usage.md');
const agentUsageJa = read('docs/agent-usage.ja.md');
const skill = read('skills/vde-open/SKILL.md');
const cli = `${repoRoot}apps/cli/src/cli.ts`;

// Leftovers of removed features (work groups, tags, and target selection).
const REMOVED = /--target|--tag|--group|\btags?\b|\bgroups?\b/i;

// The release steps for maintainers mention git tags, which are unrelated to the removed tag feature.
function withoutSection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start === -1) return text;
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(0, start) + (next === -1 ? '' : text.slice(next));
}

function help(args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, VDE_OPEN_HOME: '/nonexistent/vde-open-readme-test' },
  });
}

describe('UX-007 README and help', () => {
  it('the README explains stopping, where the state is stored, search scope, HTML limits, and name conflicts', () => {
    for (const section of [
      '## Install',
      '## `vde-open` and `vo`',
      '## Search scope',
      '## HTML display limits',
      '## Markdown display limits',
      '## Where the state is stored, and stopping',
      '## Asking a person and getting answers',
      '## Troubleshooting',
      '## Verified scope',
    ]) {
      expect(readme).toContain(section);
    }
    expect(readme).toContain('vo daemon stop');
    expect(readme).toContain('only the documents that are open right now');
    expect(readme).toContain('VDE_OPEN_HOME');
  });

  it('the English and Japanese documents link to each other', () => {
    expect(readme).toContain('[日本語](README.ja.md)');
    expect(readmeJa).toContain('[English](README.md)');
    for (const name of ['agent-usage', 'architecture', 'security-model', 'performance']) {
      expect(read(`docs/${name}.md`)).toContain(`[日本語](${name}.ja.md)`);
      expect(read(`docs/${name}.ja.md`)).toContain(`[English](${name}.md)`);
    }
  });

  it('the README, agent documents, skill, and help have no leftovers of removed features', () => {
    for (const text of [
      withoutSection(readme, '## Releasing'),
      withoutSection(readmeJa, '## 公開の手順'),
      agentUsage,
      agentUsageJa,
      skill,
    ]) {
      expect(text).not.toMatch(REMOVED);
    }
    for (const args of [[], ['open'], ['search'], ['read'], ['ask'], ['feedback'], ['daemon']]) {
      expect(help(args)).not.toMatch(REMOVED);
    }
  });

  it('the agent skill has a name and a description, and the license file exists', () => {
    expect(skill).toMatch(/^---\nname: vde-open\ndescription: .+\n---\n/);
    expect(existsSync(`${repoRoot}LICENSE`)).toBe(true);
    expect(read('LICENSE')).toContain('MIT License');
  });
});

describe('UX-008 Verified scope', () => {
  it('separates the verified OS and browsers from what is not verified', () => {
    const section = readme.slice(readme.indexOf('## Verified scope'));
    expect(section).toMatch(/macOS.*Verified/);
    expect(section).toMatch(/Linux and macOS on CI.*Verified/);
    expect(section).toMatch(/Windows on CI.*not run on Windows/);
    expect(section).toMatch(/Chromium.*the full suite is verified/);
    expect(section).toMatch(/Other UI interactions in Firefox and WebKit.*not verified/);
  });
});
