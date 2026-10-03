import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import metaSchema from '../schemas/questionnaire.schema.json' with { type: 'json' };
import {
  questionFieldSchema,
  questionnaireSchema,
  validateAnswers,
  type Questionnaire,
} from './feedback.ts';
import { LIMITS } from './limits.ts';
import { parseStrictJson, StrictJsonError } from './strict-json.ts';

const sample: Questionnaire = {
  schemaVersion: 1,
  title: 'Review of the login screen',
  instructions: 'Choose the adopted option and the display density.',
  fieldOrder: ['layout', 'density', 'comment', 'tags', 'count', 'ok'],
  answerSchema: {
    type: 'object',
    properties: {
      layout: { type: 'string', title: 'Adopted option', enum: ['A', 'B'] },
      density: { type: 'string', title: 'Display density', enum: ['comfortable', 'compact'] },
      comment: { type: 'string', title: 'Points to fix', minLength: 2, maxLength: 10 },
      tags: {
        type: 'array',
        title: 'Targets',
        uniqueItems: true,
        minItems: 1,
        maxItems: 2,
        items: { type: 'string', enum: ['header', 'footer', 'body'] },
      },
      count: { type: 'integer', title: 'Count', minimum: 0, maximum: 10 },
      ok: { type: 'boolean', title: 'No issues' },
    },
    required: ['layout', 'density'],
    additionalProperties: false,
  },
};

const parse = (value: unknown) => questionnaireSchema.safeParse(value);
const withField = (name: string, field: unknown) => ({
  ...sample,
  fieldOrder: [...sample.fieldOrder, name],
  answerSchema: {
    ...sample.answerSchema,
    properties: { ...sample.answerSchema.properties, [name]: field },
  },
});

describe('strict JSON', () => {
  it('returns the same value as JSON.parse and rejects duplicate keys with their position', () => {
    const text = '{"a":[1,2.5,-3e2,true,false,null,"x\\u0041"],"b":{"c":{}}}';
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
    expect(() => parseStrictJson('{"a":1,"b":{"c":1,"c":2}}')).toThrow(
      expect.objectContaining({ reason: 'duplicate-key', pointer: '/b/c' }),
    );
    // `__proto__` is not allowed as a key at any depth (no path where validation silently drops it).
    expect(() => parseStrictJson('{"a":{"__proto__":{"polluted":true}}}')).toThrow(
      expect.objectContaining({ reason: 'forbidden-key', pointer: '/a/__proto__' }),
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    for (const bad of ['{"a":1,}', '[1 2]', '{"a":1} x', "{'a':1}", '{"a":01}', '']) {
      expect(() => parseStrictJson(bad)).toThrow(StrictJsonError);
    }
    expect(() => parseStrictJson('['.repeat(100) + ']'.repeat(100))).toThrow(
      expect.objectContaining({ reason: 'depth' }),
    );
  });
});

describe('FB-002 validation of the question definition', () => {
  it('accepts a valid definition (including the bundled example)', () => {
    expect(parse(sample).success).toBe(true);
  });

  it('rejects unsupported structures and keywords instead of silently ignoring them', () => {
    const rejected: Array<[string, unknown]> = [
      ['remote ref', withField('remote', { $ref: 'https://example.com/schema.json' })],
      ['nested object', withField('nested', { type: 'object', title: 'nested', properties: {} })],
      ['regex pattern', withField('code', { type: 'string', title: 'code', pattern: '^a+$' })],
      ['arbitrary format', withField('mail', { type: 'string', title: 'mail', format: 'email' })],
      ['anyOf', withField('either', { anyOf: [{ type: 'string' }], title: 'x' })],
      ['default', withField('pre', { type: 'string', title: 'x', default: 'A' })],
      ['unknown keyword', { ...sample, extra: true }],
      [
        'root is not an object',
        { ...sample, answerSchema: { ...sample.answerSchema, type: 'array' } },
      ],
      [
        'additionalProperties is not false',
        {
          ...sample,
          answerSchema: { ...sample.answerSchema, additionalProperties: true },
        },
      ],
      [
        'array without uniqueItems',
        withField('list', {
          type: 'array',
          title: 'x',
          maxItems: 2,
          items: { type: 'string', enum: ['a'] },
        }),
      ],
      [
        'array without maxItems',
        withField('list', {
          type: 'array',
          title: 'x',
          uniqueItems: true,
          items: { type: 'string', enum: ['a'] },
        }),
      ],
      [
        'array whose items have no enum',
        withField('list', {
          type: 'array',
          title: 'x',
          uniqueItems: true,
          maxItems: 2,
          items: { type: 'string' },
        }),
      ],
      [
        'inverted minimum and maximum',
        withField('range', { type: 'number', title: 'x', minimum: 5, maximum: 1 }),
      ],
      [
        'inverted length limits',
        withField('text', { type: 'string', title: 'x', minLength: 5, maxLength: 1 }),
      ],
      [
        'maxLength above the limit',
        withField('text', { type: 'string', title: 'x', maxLength: 4001 }),
      ],
      ['duplicate choices', withField('pick', { type: 'string', title: 'x', enum: ['a', 'a'] })],
      ['incomplete fieldOrder', { ...sample, fieldOrder: ['layout'] }],
      ['duplicate in fieldOrder', { ...sample, fieldOrder: [...sample.fieldOrder, 'layout'] }],
      [
        'required names a missing field',
        {
          ...sample,
          answerSchema: { ...sample.answerSchema, required: ['missing'] },
        },
      ],
      ['title too long', { ...sample, title: 'x'.repeat(161) }],
    ];
    for (const [label, value] of rejected) {
      expect(parse(value).success, label).toBe(false);
    }
  });

  it('rejects field names that point at the prototype and names that break the rules', () => {
    for (const name of ['constructor', 'prototype', 'toString', 'hasOwnProperty', '1st', 'a-b']) {
      expect(parse(withField(name, { type: 'boolean', title: 'x' })).success, name).toBe(false);
    }
    // A `__proto__` key in JSON is rejected by the strict JSON parser, before Zod validation.
    const text = JSON.stringify(sample).replace(
      '"ok":{"type":"boolean","title":"No issues"}',
      '"ok":{"type":"boolean","title":"No issues"},"__proto__":{"type":"boolean","title":"x"}',
    );
    expect(() => parseStrictJson(text)).toThrow(
      expect.objectContaining({ reason: 'forbidden-key' }),
    );
  });

  it('rejects a definition with more fields than the limit', () => {
    const names = Array.from(
      { length: LIMITS.questionFields + 1 },
      (_, index) => `f${String(index)}`,
    );
    const properties = Object.fromEntries(
      names.map((name) => [name, { type: 'boolean', title: 'x' }]),
    );
    expect(
      parse({
        ...sample,
        fieldOrder: names,
        answerSchema: { ...sample.answerSchema, properties, required: [] },
      }).success,
    ).toBe(false);
  });

  it('the field contract matches the bundled meta-schema (contract test)', () => {
    // Compares the accepted keys, the required keys and the value ranges. Differences in how types are written (such as listing several types) are not compared.
    const LIMIT_KEYS = [
      'const',
      'enum',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ];
    type Node = Record<string, unknown>;
    const project = (node: Node | undefined): unknown => {
      if (!node) return null;
      const out: Node = {};
      for (const key of LIMIT_KEYS) if (key in node) out[key] = node[key];
      if (node['properties']) {
        const properties = node['properties'] as Record<string, Node>;
        out['properties'] = Object.fromEntries(
          Object.keys(properties)
            .toSorted()
            .map((key) => [key, project(properties[key])]),
        );
        out['required'] = ((node['required'] as string[] | undefined) ?? []).toSorted();
        out['additionalProperties'] = node['additionalProperties'];
      }
      if (node['items']) out['items'] = project(node['items'] as Node);
      return out;
    };
    const ours = z.toJSONSchema(questionFieldSchema) as { oneOf: Node[] };
    const theirs = (metaSchema as { $defs: { field: { oneOf: Node[] } } }).$defs.field.oneOf;
    expect(ours.oneOf.map(project)).toEqual(theirs.map(project));
    // The meta-schema forbids duplicate choices with uniqueItems; Zod checks it with refine.
    expect(parse(withField('pick', { type: 'string', title: 'x', enum: ['a', 'a'] })).success).toBe(
      false,
    );
    // The root's required keys and accepted keys also match.
    const root = metaSchema as Node;
    expect(Object.keys(root['properties'] as Node).toSorted()).toEqual(
      Object.keys(questionnaireSchema.shape).toSorted(),
    );
    expect((root['required'] as string[]).toSorted()).toEqual(
      ['schemaVersion', 'title', 'fieldOrder', 'answerSchema'].toSorted(),
    );
  });
});

describe('FB-003 validation of answers', () => {
  const issues = (answers: unknown, complete: boolean) =>
    validateAnswers(sample, answers, { complete }).map((issue) => `${issue.field}:${issue.code}`);

  it('a draft answer may be incomplete; only the type, value and size of the fields present are validated', () => {
    expect(issues({}, false)).toEqual([]);
    expect(issues({ layout: 'A', comment: 'x' }, false)).toEqual([]);
    expect(issues({ layout: 'C' }, false)).toEqual(['layout:enum']);
    expect(issues({ count: '3' }, false)).toEqual(['count:type']);
    expect(issues({ count: 1.5 }, false)).toEqual(['count:type']);
    expect(issues({ count: 11 }, false)).toEqual(['count:out-of-range']);
    expect(issues({ ok: 'true' }, false)).toEqual(['ok:type']);
    expect(issues({ comment: 'x'.repeat(11) }, false)).toEqual(['comment:too-long']);
    expect(issues({ tags: ['header', 'header'] }, false)).toEqual(['tags:duplicate']);
    expect(issues({ tags: ['header', 'footer', 'body'] }, false)).toEqual(['tags:too-many']);
    expect(issues({ tags: ['other'] }, false)).toEqual(['tags:enum']);
    expect(issues({ unknown: 1 }, false)).toEqual(['unknown:unknown-field']);
    expect(issues([], false)).toEqual([':not-object']);
    expect(issues({ layout: null }, false)).toEqual(['layout:type']);
  });

  it('submit also validates required and minimum constraints, and does not coerce types', () => {
    expect(issues({}, true).toSorted()).toEqual(['density:required', 'layout:required']);
    expect(issues({ layout: 'A', density: 'compact' }, true)).toEqual([]);
    expect(issues({ layout: 'A', density: 'compact', comment: 'x' }, true)).toEqual([
      'comment:too-short',
    ]);
    expect(issues({ layout: 'A', density: 'compact', tags: [] }, true)).toEqual(['tags:too-few']);
    // Length is counted in Unicode code points.
    expect(issues({ layout: 'A', density: 'compact', comment: '😀😀' }, true)).toEqual([]);
  });

  it('rejects an answer above 64KiB and accepts one at the maximum size', () => {
    const big: Questionnaire = {
      ...sample,
      fieldOrder: Array.from({ length: 17 }, (_, index) => `t${String(index)}`),
      answerSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [
            `t${String(index)}`,
            { type: 'string', title: 'x', maxLength: 4000 },
          ]),
        ),
        required: [],
        additionalProperties: false,
      },
    };
    const fill = (count: number, length: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`t${String(index)}`, 'a'.repeat(length)]),
      );
    // 16 × 4000 + keys and punctuation < 64KiB
    expect(validateAnswers(big, fill(16, 4000), { complete: false })).toEqual([]);
    expect(validateAnswers(big, fill(17, 4000), { complete: false })).toEqual([
      { field: '', code: 'too-large' },
    ]);
  });
});
