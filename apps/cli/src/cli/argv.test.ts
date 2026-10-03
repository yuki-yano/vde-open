import { describe, expect, it } from 'vitest';

import { normalizeArgv, type ArgvRules } from './argv.ts';

const rules: ArgvRules = {
  subcommands: new Set(['open', 'list', 'read', 'close', 'daemon', 'serve', 'doctor', 'help']),
  valueOptions: new Set(['--format', '--title', '--key']),
};

describe('delegates top-level file arguments to open', () => {
  it.each([
    [['a.md', 'b.html'], false, ['open', 'a.md', 'b.html']],
    [['--json', 'a.md'], false, ['open', '--json', 'a.md']],
    [['list', '--json'], false, ['list', '--json']],
    [['open', './read'], false, ['open', './read']],
    [['--', 'read'], false, ['open', '--', 'read']],
    [['-', '--format', 'markdown'], false, ['open', '-', '--format', 'markdown']],
    [['--format', 'markdown'], true, ['open', '--format', 'markdown']],
    [[], true, ['open']],
    [[], false, []],
    [['--help'], true, ['--help']],
    [['--version'], false, ['--version']],
    // An option value equal to a subcommand name is not treated as a subcommand.
    [['--title', 'read', 'a.md'], false, ['open', '--title', 'read', 'a.md']],
    [
      ['--key', 'list', '--format', 'markdown'],
      true,
      ['open', '--key', 'list', '--format', 'markdown'],
    ],
    [['--title=read', 'a.md'], false, ['open', '--title=read', 'a.md']],
    [['--json', 'list'], false, ['--json', 'list']],
  ])('%j (stdin piped: %s) -> %j', (argv, piped, expected) => {
    expect(normalizeArgv(argv, piped, rules)).toEqual(expected);
  });
});
