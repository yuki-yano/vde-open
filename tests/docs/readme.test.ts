import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const skill = readFileSync(`${repoRoot}skills/vde-open/SKILL.md`, 'utf8');

describe('UX-007 agent skill', () => {
  it('the agent skill has a name and a description', () => {
    expect(skill).toMatch(/^---\nname: vde-open\ndescription: .+\n---\n/);
  });
});
