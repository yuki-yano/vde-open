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
  title: 'ログイン画面の確認',
  instructions: '採用案と表示密度を選んでください。',
  fieldOrder: ['layout', 'density', 'comment', 'tags', 'count', 'ok'],
  answerSchema: {
    type: 'object',
    properties: {
      layout: { type: 'string', title: '採用案', enum: ['A', 'B'] },
      density: { type: 'string', title: '表示密度', enum: ['comfortable', 'compact'] },
      comment: { type: 'string', title: '修正したい点', minLength: 2, maxLength: 10 },
      tags: {
        type: 'array',
        title: '対象',
        uniqueItems: true,
        minItems: 1,
        maxItems: 2,
        items: { type: 'string', enum: ['header', 'footer', 'body'] },
      },
      count: { type: 'integer', title: '件数', minimum: 0, maximum: 10 },
      ok: { type: 'boolean', title: '問題なし' },
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
  it('JSON.parseと同じ値を返し、重複したkeyを位置付きで拒否する', () => {
    const text = '{"a":[1,2.5,-3e2,true,false,null,"x\\u0041"],"b":{"c":{}}}';
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
    expect(() => parseStrictJson('{"a":1,"b":{"c":1,"c":2}}')).toThrow(
      expect.objectContaining({ reason: 'duplicate-key', pointer: '/b/c' }),
    );
    // `__proto__`は、どの深さでもkeyに使えない（検証で黙って捨てられる経路を作らない）。
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

describe('FB-002 質問定義の検証', () => {
  it('正しい定義を受け付ける（同梱の例も含む）', () => {
    expect(parse(sample).success).toBe(true);
  });

  it('対応しない構造・keywordを、黙って無視せずに拒否する', () => {
    const rejected: Array<[string, unknown]> = [
      ['remote ref', withField('remote', { $ref: 'https://example.com/schema.json' })],
      ['nested object', withField('nested', { type: 'object', title: '入れ子', properties: {} })],
      ['regex pattern', withField('code', { type: 'string', title: 'code', pattern: '^a+$' })],
      ['任意のformat', withField('mail', { type: 'string', title: 'mail', format: 'email' })],
      ['anyOf', withField('either', { anyOf: [{ type: 'string' }], title: 'x' })],
      ['default', withField('pre', { type: 'string', title: 'x', default: 'A' })],
      ['未知のkeyword', { ...sample, extra: true }],
      [
        'rootがobjectでない',
        { ...sample, answerSchema: { ...sample.answerSchema, type: 'array' } },
      ],
      [
        'additionalPropertiesがfalseでない',
        {
          ...sample,
          answerSchema: { ...sample.answerSchema, additionalProperties: true },
        },
      ],
      [
        'arrayのuniqueItemsなし',
        withField('list', {
          type: 'array',
          title: 'x',
          maxItems: 2,
          items: { type: 'string', enum: ['a'] },
        }),
      ],
      [
        'arrayのmaxItemsなし',
        withField('list', {
          type: 'array',
          title: 'x',
          uniqueItems: true,
          items: { type: 'string', enum: ['a'] },
        }),
      ],
      [
        'enum以外のarray',
        withField('list', {
          type: 'array',
          title: 'x',
          uniqueItems: true,
          maxItems: 2,
          items: { type: 'string' },
        }),
      ],
      ['上下限の逆転', withField('range', { type: 'number', title: 'x', minimum: 5, maximum: 1 })],
      ['長さの逆転', withField('text', { type: 'string', title: 'x', minLength: 5, maxLength: 1 })],
      ['maxLengthの上限超え', withField('text', { type: 'string', title: 'x', maxLength: 4001 })],
      ['選択肢の重複', withField('pick', { type: 'string', title: 'x', enum: ['a', 'a'] })],
      ['fieldOrderの不足', { ...sample, fieldOrder: ['layout'] }],
      ['fieldOrderの重複', { ...sample, fieldOrder: [...sample.fieldOrder, 'layout'] }],
      [
        '存在しないrequired',
        {
          ...sample,
          answerSchema: { ...sample.answerSchema, required: ['missing'] },
        },
      ],
      ['titleの長さ', { ...sample, title: 'x'.repeat(161) }],
    ];
    for (const [label, value] of rejected) {
      expect(parse(value).success, label).toBe(false);
    }
  });

  it('prototypeを指すfield名と、規則に合わないfield名を拒否する', () => {
    for (const name of ['constructor', 'prototype', 'toString', 'hasOwnProperty', '1st', 'a-b']) {
      expect(parse(withField(name, { type: 'boolean', title: 'x' })).success, name).toBe(false);
    }
    // JSONの`__proto__` keyは、Zodの検証の前に、strict JSONの読み込みで拒否する。
    const text = JSON.stringify(sample).replace(
      '"ok":{"type":"boolean","title":"問題なし"}',
      '"ok":{"type":"boolean","title":"問題なし"},"__proto__":{"type":"boolean","title":"x"}',
    );
    expect(() => parseStrictJson(text)).toThrow(
      expect.objectContaining({ reason: 'forbidden-key' }),
    );
  });

  it('fieldの数の上限を超える定義を拒否する', () => {
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

  it('同梱のmeta-schemaとfieldの契約が一致する（contract test）', () => {
    // 比べるのは、受け付けるkeyと必須のkey、値の範囲。型の書き方の違い（typeの併記など）は比べない。
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
    // meta-schemaの選択肢の重複禁止（uniqueItems）は、Zodではrefineで検証する。
    expect(parse(withField('pick', { type: 'string', title: 'x', enum: ['a', 'a'] })).success).toBe(
      false,
    );
    // rootの必須keyと、受け付けるkeyも一致する。
    const root = metaSchema as Node;
    expect(Object.keys(root['properties'] as Node).toSorted()).toEqual(
      Object.keys(questionnaireSchema.shape).toSorted(),
    );
    expect((root['required'] as string[]).toSorted()).toEqual(
      ['schemaVersion', 'title', 'fieldOrder', 'answerSchema'].toSorted(),
    );
  });
});

describe('FB-003 回答の検証', () => {
  const issues = (answers: unknown, complete: boolean) =>
    validateAnswers(sample, answers, { complete }).map((issue) => `${issue.field}:${issue.code}`);

  it('回答案は未完成を許し、あるfieldの型・値・大きさだけを検証する', () => {
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

  it('送信では、必須と最小の条件も検証する。型は変換しない', () => {
    expect(issues({}, true).toSorted()).toEqual(['density:required', 'layout:required']);
    expect(issues({ layout: 'A', density: 'compact' }, true)).toEqual([]);
    expect(issues({ layout: 'A', density: 'compact', comment: 'x' }, true)).toEqual([
      'comment:too-short',
    ]);
    expect(issues({ layout: 'A', density: 'compact', tags: [] }, true)).toEqual(['tags:too-few']);
    // 文字数はUnicode code pointで数える。
    expect(issues({ layout: 'A', density: 'compact', comment: '😀😀' }, true)).toEqual([]);
  });

  it('64KiBを超える回答は拒否する。最大の大きさの回答は受け付ける', () => {
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
    // 16 × 4000 + keyと記号 < 64KiB
    expect(validateAnswers(big, fill(16, 4000), { complete: false })).toEqual([]);
    expect(validateAnswers(big, fill(17, 4000), { complete: false })).toEqual([
      { field: '', code: 'too-large' },
    ]);
  });
});
