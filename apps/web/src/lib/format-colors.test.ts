import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { colorPalettes } from './preferences';

// Contrast of the list's colors, computed from the tokens in index.css (WCAG 2.2 relative luminance).
// Icons need 3:1 (1.4.11 non-text contrast) and the second line of a row 4.5:1 (1.4.3), against the
// background and against the selected row (hover uses the same color).

const css = readFileSync(new URL('../themes.css', import.meta.url), 'utf8');

function tokensOf(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Missing palette selector: ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens.set(match[1] as string, (match[2] as string).trim());
  }
  return tokens;
}

const themes = colorPalettes.flatMap(({ value }) => {
  const overrides =
    value === 'standard'
      ? new Map<string, string>()
      : tokensOf(`:root[data-color-palette='${value}']`);
  return [
    [`${value} light`, new Map([...tokensOf(':root'), ...overrides])],
    [
      `${value} dark`,
      new Map([
        ...tokensOf(':root'),
        ...tokensOf('.dark'),
        ...overrides,
        ...(value === 'standard' ? [] : tokensOf(`:root[data-color-palette='${value}'].dark`)),
      ]),
    ],
  ] as const;
});

function resolve(tokens: Map<string, string>, name: string): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`${name} is not defined`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  return reference ? resolve(tokens, reference[1] as string) : value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const [r, g, b] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(tokens: Map<string, string>, foreground: string, background: string): number {
  const [high, low] = [
    luminance(resolve(tokens, foreground)),
    luminance(resolve(tokens, background)),
  ].toSorted((a, b) => b - a) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe.each(themes)('%s theme', (_name, tokens) => {
  // The list sits on the background. The selected row uses accent and a hovered row muted.
  const backgrounds = ['--background', '--accent', '--muted'];

  it.each(['--format-markdown', '--format-html', '--muted-foreground'])(
    '%s icons reach 3:1',
    (color) => {
      for (const background of backgrounds) {
        expect(contrast(tokens, color, background)).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it('second-line text reaches 4.5:1', () => {
    for (const background of backgrounds) {
      expect(contrast(tokens, '--muted-foreground', background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('body text, links, and primary buttons reach 4.5:1', () => {
    for (const background of backgrounds) {
      expect(contrast(tokens, '--foreground', background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tokens, '--link', '--background')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens, '--primary-foreground', '--primary')).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    'keyword',
    'string',
    'number',
    'comment',
    'operator',
    'function',
    'type',
    'variable',
    'heading',
  ])('syntax %s reaches 4.5:1 on code blocks', (role) => {
    expect(contrast(tokens, `--syntax-${role}`, '--muted')).toBeGreaterThanOrEqual(4.5);
  });

  it('tells Markdown and HTML apart by color', () => {
    expect(resolve(tokens, '--format-markdown')).not.toBe(resolve(tokens, '--format-html'));
  });
});
