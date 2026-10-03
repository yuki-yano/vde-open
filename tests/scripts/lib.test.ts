import { describe, expect, it } from 'vitest';

import { cmdShimInvocation, quoteForCmd } from '../../scripts/lib.ts';

// Not verified on a real Windows machine. Only pins down how the string passed to cmd.exe is built.
describe('quoting for cmd.exe', () => {
  it('turns an argument with spaces or meta characters into a form passed as one argument', () => {
    expect(quoteForCmd('a b', false)).toBe('^"a^ b^"');
    expect(quoteForCmd('a&b', false)).toBe('^"a^&b^"');
    expect(quoteForCmd('a"b', false)).toBe('^"a\\^"b^"');
  });

  it('doubles trailing backslashes so they do not escape the closing quote', () => {
    expect(quoteForCmd('C:\\dir\\', false)).toBe('^"C:\\dir\\\\^"');
  });

  it('escapes meta characters twice for a .cmd shim', () => {
    expect(quoteForCmd('--version', true)).toBe('^^^"--version^^^"');
  });

  it('combines the shim path and arguments into a command line passed to cmd.exe as is', () => {
    const invocation = cmdShimInvocation('C:\\Temp\\my dir\\vo.cmd', ['--help']);
    expect(invocation.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\Temp\\my^ dir\\vo.cmd ^^^"--help^^^""',
    ]);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });
});
