import { describe, expect, it } from 'vitest';

import { escapeForTerminal, safeJson } from './output.ts';

const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const title = 'x\u001b[2Jy \u001b]0;乗っ取り\u0007 \u009b31m \u007f\u2028';

describe('CLI-016 control characters in titles and paths', () => {
  it('JSON output stays one line with no raw control characters and parses back to the same value', () => {
    const json = safeJson({ title });
    expect(RAW_CONTROL.test(json)).toBe(false);
    expect(JSON.parse(json)).toEqual({ title });
  });

  it('text output escapes control characters in a title or path instead of passing them to the terminal', () => {
    const shown = escapeForTerminal(`bad\u001b[31mname.md\n${title}`);
    expect(RAW_CONTROL.test(shown)).toBe(false);
    expect(shown).toContain('bad\\u001b[31mname.md\\u000ax\\u001b[2Jy');
  });
});
