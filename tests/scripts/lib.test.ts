import { describe, expect, it } from 'vitest';

import { cmdShimInvocation, quoteForCmd } from '../../scripts/lib.ts';

// Windowsの実機では未検証。cmd.exeへ渡す文字列の組み立てだけをここで固定する。
describe('cmd.exe向けのquote', () => {
  it('空白やmeta文字を含む引数を1つの引数として渡せる形にする', () => {
    expect(quoteForCmd('a b', false)).toBe('^"a^ b^"');
    expect(quoteForCmd('a&b', false)).toBe('^"a^&b^"');
    expect(quoteForCmd('a"b', false)).toBe('^"a\\^"b^"');
  });

  it('末尾のbackslashを倍にして、閉じ引用符をescapeさせない', () => {
    expect(quoteForCmd('C:\\dir\\', false)).toBe('^"C:\\dir\\\\^"');
  });

  it('.cmdのshim向けにはmeta文字を二重にescapeする', () => {
    expect(quoteForCmd('--version', true)).toBe('^^^"--version^^^"');
  });

  it('shimのpathと引数を、cmd.exeへそのまま渡すcommand lineにまとめる', () => {
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
