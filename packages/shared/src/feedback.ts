import { z } from 'zod';

import { canonicalJson } from './canonical-json.ts';
import { documentIdSchema, htmlModeSchema, revisionSchema } from './documents.ts';
import { LIMITS } from './limits.ts';

// 質問定義（仕様11.2）。任意のJSON Schemaではなく、決まった形だけを受け付ける。
// 同梱の`packages/shared/schemas/questionnaire.schema.json`と同じ契約で、contract testで一致を確かめる。

export const requestIdSchema = z.string().regex(/^req_[0-9a-f-]{36}$/);
export const submissionIdSchema = z.string().regex(/^sub_[0-9a-f-]{36}$/);

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// objectの組み込みの名前。回答のkeyにすると、prototypeの値と取り違える。
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  ...Object.getOwnPropertyNames(Object.prototype),
]);

export const fieldNameSchema = z
  .string()
  .regex(FIELD_NAME)
  .refine((name) => !RESERVED_NAMES.has(name), { message: 'このfield名は使えません。' });

const fieldTitle = z.string().min(1).max(160);
const fieldDescription = z.string().max(2000);
const enumValues = z
  .array(z.string().max(160))
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length, {
    message: '選択肢が重複しています。',
  });
const lengthLimit = z.number().int().min(0).max(LIMITS.answerStringLength);
const finite = z.number().refine(Number.isFinite, { message: '有限の数を指定してください。' });

const stringFieldSchema = z.strictObject({
  type: z.literal('string'),
  title: fieldTitle,
  description: fieldDescription.optional(),
  minLength: lengthLimit.optional(),
  maxLength: lengthLimit.optional(),
  enum: enumValues.optional(),
});

const booleanFieldSchema = z.strictObject({
  type: z.literal('boolean'),
  title: fieldTitle,
  description: fieldDescription.optional(),
});

const numberFieldSchema = z.strictObject({
  type: z.enum(['number', 'integer']),
  title: fieldTitle,
  description: fieldDescription.optional(),
  minimum: finite.optional(),
  maximum: finite.optional(),
});

const arrayFieldSchema = z.strictObject({
  type: z.literal('array'),
  title: fieldTitle,
  description: fieldDescription.optional(),
  minItems: z.number().int().min(0).max(32).optional(),
  maxItems: z.number().int().min(0).max(32),
  uniqueItems: z.literal(true),
  items: z.strictObject({ type: z.literal('string'), enum: enumValues }),
});

export const questionFieldSchema = z.discriminatedUnion('type', [
  stringFieldSchema,
  booleanFieldSchema,
  numberFieldSchema,
  arrayFieldSchema,
]);
export type QuestionField = z.infer<typeof questionFieldSchema>;

export const questionnaireSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    title: fieldTitle,
    instructions: z.string().max(4000).optional(),
    fieldOrder: z.array(fieldNameSchema).min(1).max(LIMITS.questionFields),
    answerSchema: z.strictObject({
      type: z.literal('object'),
      properties: z.record(fieldNameSchema, questionFieldSchema).refine(
        (properties) => {
          const count = Object.keys(properties).length;
          return count >= 1 && count <= LIMITS.questionFields;
        },
        { message: `fieldは1〜${String(LIMITS.questionFields)}件です。` },
      ),
      required: z.array(fieldNameSchema).max(LIMITS.questionFields),
      additionalProperties: z.literal(false),
    }),
  })
  .superRefine((questionnaire, context) => {
    const names = Object.keys(questionnaire.answerSchema.properties);
    const order = questionnaire.fieldOrder;
    if (new Set(order).size !== order.length) {
      context.addIssue({ code: 'custom', path: ['fieldOrder'], message: '重複があります。' });
    }
    if (order.length !== names.length || !names.every((name) => order.includes(name))) {
      context.addIssue({
        code: 'custom',
        path: ['fieldOrder'],
        message: 'fieldOrderとpropertiesのfieldが一致しません。',
      });
    }
    const { required } = questionnaire.answerSchema;
    if (new Set(required).size !== required.length) {
      context.addIssue({
        code: 'custom',
        path: ['answerSchema', 'required'],
        message: '重複があります。',
      });
    }
    for (const name of required) {
      if (!names.includes(name)) {
        context.addIssue({
          code: 'custom',
          path: ['answerSchema', 'required'],
          message: `存在しないfieldです: ${name}`,
        });
      }
    }
    for (const [name, field] of Object.entries(questionnaire.answerSchema.properties)) {
      const path = ['answerSchema', 'properties', name];
      const inverted =
        (field.type === 'string' &&
          field.minLength !== undefined &&
          field.maxLength !== undefined &&
          field.minLength > field.maxLength) ||
        ((field.type === 'number' || field.type === 'integer') &&
          field.minimum !== undefined &&
          field.maximum !== undefined &&
          field.minimum > field.maximum) ||
        (field.type === 'array' && field.minItems !== undefined && field.minItems > field.maxItems);
      if (inverted) context.addIssue({ code: 'custom', path, message: '上限と下限が逆です。' });
      if (
        field.type === 'array' &&
        field.minItems !== undefined &&
        field.minItems > field.items.enum.length
      ) {
        context.addIssue({ code: 'custom', path, message: '選択肢より多い最小数です。' });
      }
    }
  });
export type Questionnaire = z.infer<typeof questionnaireSchema>;

// 回答の値。stringのarrayは、選択肢のarray。
export const answerValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.number(),
  z.array(z.string()),
]);
export type AnswerValue = z.infer<typeof answerValueSchema>;
export const answersSchema = z.record(fieldNameSchema, answerValueSchema);
export type Answers = z.infer<typeof answersSchema>;

export interface AnswerIssue {
  // field名。回答全体の問題は''。値は含めない（秘密を書かれていても、errorに写さない）。
  field: string;
  code:
    | 'not-object'
    | 'too-large'
    | 'unknown-field'
    | 'required'
    | 'type'
    | 'enum'
    | 'too-long'
    | 'too-short'
    | 'out-of-range'
    | 'duplicate'
    | 'too-many'
    | 'too-few';
}

function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

// UTF-8での大きさ。browserとNode.jsの両方で同じ値になるよう、文字から数える。
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function byteLengthOfJson(value: unknown): number {
  return utf8Length(canonicalJson(value));
}

// 回答を検証する（仕様11.2）。completeなら送信時の検証（必須と最小の条件も見る）、
// そうでなければ回答案の検証（未完成を許し、あるfieldの型・値・大きさだけを見る）。
// 型の変換はしない。問題がなければ空の配列。
export function validateAnswers(
  questionnaire: Questionnaire,
  answers: unknown,
  options: { complete: boolean },
): AnswerIssue[] {
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
    return [{ field: '', code: 'not-object' }];
  }
  let bytes: number;
  try {
    bytes = byteLengthOfJson(answers);
  } catch {
    // JSONで表せない値（undefinedや非有限の数）を含む。
    return [{ field: '', code: 'type' }];
  }
  if (bytes > LIMITS.answerBytes) return [{ field: '', code: 'too-large' }];
  const issues: AnswerIssue[] = [];
  const { properties, required } = questionnaire.answerSchema;
  for (const name of Object.keys(answers)) {
    if (!Object.hasOwn(properties, name)) issues.push({ field: name, code: 'unknown-field' });
  }
  for (const [name, field] of Object.entries(properties)) {
    const has = Object.hasOwn(answers, name);
    if (!has) {
      if (options.complete && required.includes(name))
        issues.push({ field: name, code: 'required' });
      continue;
    }
    const value = (answers as Record<string, unknown>)[name];
    const issue = (code: AnswerIssue['code']) => issues.push({ field: name, code });
    switch (field.type) {
      case 'string': {
        if (typeof value !== 'string') {
          issue('type');
          break;
        }
        if (field.enum !== undefined && !field.enum.includes(value)) issue('enum');
        const length = codePointLength(value);
        if (length > (field.maxLength ?? LIMITS.answerStringLength)) issue('too-long');
        else if (options.complete && field.minLength !== undefined && length < field.minLength) {
          issue('too-short');
        }
        break;
      }
      case 'boolean':
        if (typeof value !== 'boolean') issue('type');
        break;
      case 'number':
      case 'integer': {
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          (field.type === 'integer' && !Number.isInteger(value))
        ) {
          issue('type');
          break;
        }
        if (
          (field.minimum !== undefined && value < field.minimum) ||
          (field.maximum !== undefined && value > field.maximum)
        ) {
          issue('out-of-range');
        }
        break;
      }
      case 'array': {
        if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
          issue('type');
          break;
        }
        if (!value.every((item) => field.items.enum.includes(item))) issue('enum');
        if (new Set(value).size !== value.length) issue('duplicate');
        if (value.length > field.maxItems) issue('too-many');
        else if (
          options.complete &&
          field.minItems !== undefined &&
          value.length < field.minItems
        ) {
          issue('too-few');
        }
        break;
      }
    }
  }
  return issues;
}

export const feedbackStatusSchema = z.enum(['pending', 'submitted', 'cancelled']);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

export const cancellationReasonSchema = z.enum([
  'document_closed',
  'agent_cancelled',
  'user_cancelled',
]);

export const submissionSchema = z.strictObject({
  submissionId: submissionIdSchema,
  answers: answersSchema,
  submittedAt: z.string(),
  // 回答した版（質問を作ったときに固定した版）。
  revision: revisionSchema,
  // 新しい版があると確認したうえで、固定した版への回答として送ったか。
  confirmedAgainstOlderRevision: z.boolean(),
  // 送信の時点で確認した、文書の現在の版。
  currentRevisionAtSubmit: revisionSchema.nullable(),
});
export type Submission = z.infer<typeof submissionSchema>;

export const cancellationSchema = z.strictObject({
  cancelledAt: z.string(),
  reason: cancellationReasonSchema,
});

// Agentへ返す質問の状態。回答案（draft）は含めない（仕様11.3）。確定した回答だけを返す。
export const feedbackForAgentSchema = z.strictObject({
  requestId: requestIdSchema,
  documentId: documentIdSchema,
  revision: revisionSchema,
  title: z.string(),
  status: feedbackStatusSchema,
  createdAt: z.string(),
  submission: submissionSchema.nullable(),
  cancellation: cancellationSchema.nullable(),
  acknowledgedAt: z.string().nullable(),
});
export type FeedbackForAgent = z.infer<typeof feedbackForAgentSchema>;

// 管理UIへ返す質問の状態。質問定義と回答案、文書の現在の版を含む。
export const feedbackForUiSchema = feedbackForAgentSchema.extend({
  questionnaire: questionnaireSchema,
  // 質問を作ったときに固定した表示方法。interactiveなら、HTMLから回答案を送れる。
  renderMode: htmlModeSchema,
  draftVersion: z.number().int().nonnegative(),
  draftAnswers: answersSchema,
  // 文書の現在の版。固定した版と違えば、新しい版がある。
  currentRevision: revisionSchema.nullable(),
  documentOpen: z.boolean(),
});
export type FeedbackForUi = z.infer<typeof feedbackForUiSchema>;

export const feedbackCreateParamsSchema = z
  .strictObject({
    cwd: z.string().min(1),
    // 質問定義のJSONの原文。重複したkeyを見つけるため、daemonが原文から読む。
    questionnaire: z.string(),
    // 既存の開いている文書へ質問する。
    documentId: documentIdSchema.optional(),
    revision: revisionSchema.optional(),
    // 文書を開いてから、その版へ質問する。
    view: z.string().min(1).optional(),
    htmlMode: htmlModeSchema.optional(),
    assetsRoot: z.string().min(1).optional(),
    assets: z.array(z.string().min(1)).max(LIMITS.documentAssets).default([]),
    // 再試行で同じ質問を重ねて作らないための識別子。
    operationId: z.uuid().optional(),
  })
  .superRefine((params, context) => {
    if (params.documentId !== undefined && params.view !== undefined) {
      context.addIssue({ code: 'custom', message: '--documentと--viewは同時に指定できません。' });
    }
    if (params.revision !== undefined && params.documentId === undefined) {
      context.addIssue({ code: 'custom', message: '--revisionは--documentと一緒に指定します。' });
    }
    const viewOnly =
      params.htmlMode !== undefined || params.assetsRoot !== undefined || params.assets.length > 0;
    if (viewOnly && params.view === undefined) {
      context.addIssue({
        code: 'custom',
        message:
          '--html-mode・--assets-root・--assetは、--viewで新しく開く文書にだけ指定できます。',
      });
    }
  });
export type FeedbackCreateParams = z.input<typeof feedbackCreateParamsSchema>;

export const feedbackCreateResultSchema = z.strictObject({
  request: feedbackForAgentSchema,
  // 同じoperation IDの再送で、前に作った質問を返したか。
  replayed: z.boolean(),
});
export type FeedbackCreateResult = z.infer<typeof feedbackCreateResultSchema>;

export const feedbackListParamsSchema = z.strictObject({
  status: feedbackStatusSchema.optional(),
});
export const feedbackListResultSchema = z.strictObject({
  requests: z.array(feedbackForAgentSchema),
});
export type FeedbackListResult = z.infer<typeof feedbackListResultSchema>;

export const feedbackIdParamsSchema = z.strictObject({ requestId: requestIdSchema });

export const feedbackWaitParamsSchema = z.strictObject({
  requestId: requestIdSchema,
  // 待つ上限。CLIが残り時間を渡す。
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.feedbackWaitMaxSeconds * 1000),
});

export const feedbackAckParamsSchema = z.strictObject({
  requestId: requestIdSchema,
  submissionId: submissionIdSchema,
});

export const feedbackForgetParamsSchema = z.strictObject({
  requestId: requestIdSchema,
  // 消すことの明示的な確認（`--yes`）。
  confirmed: z.boolean(),
});

export const feedbackDraftParamsSchema = z.strictObject({
  expectedDraftVersion: z.number().int().nonnegative(),
  answers: z.unknown(),
});

export const feedbackSubmitParamsSchema = z.strictObject({
  submissionId: submissionIdSchema,
  expectedDraftVersion: z.number().int().nonnegative(),
  // 質問を作ったときに固定した版。
  revision: revisionSchema,
  // 送信の画面で確認した、文書の現在の版。
  currentRevision: revisionSchema.nullable(),
  // 新しい版があると確認したうえで、固定した版への回答として送る。管理UIの操作でだけ設定する。
  confirmOlderRevision: z.boolean().default(false),
});
export type FeedbackSubmitParams = z.input<typeof feedbackSubmitParamsSchema>;

export const feedbackCancelParamsSchema = z.strictObject({
  // 中止の確認（管理UIで確認したこと）。
  confirmed: z.literal(true),
});
