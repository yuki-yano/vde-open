import { z } from 'zod';

import { canonicalJson } from './canonical-json.ts';
import { documentIdSchema, htmlModeSchema, revisionSchema } from './documents.ts';
import { LIMITS } from './limits.ts';

// Question definition (spec 11.2). Accepts only a fixed shape, not arbitrary JSON Schema.
// Same contract as the bundled `packages/shared/schemas/questionnaire.schema.json`; a contract test checks they match.

export const requestIdSchema = z.string().regex(/^req_[0-9a-f-]{36}$/);
export const submissionIdSchema = z.string().regex(/^sub_[0-9a-f-]{36}$/);

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Built-in object names. Used as answer keys, they get confused with prototype values.
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  ...Object.getOwnPropertyNames(Object.prototype),
]);

export const fieldNameSchema = z
  .string()
  .regex(FIELD_NAME)
  .refine((name) => !RESERVED_NAMES.has(name), { message: 'This field name cannot be used.' });

const fieldTitle = z.string().min(1).max(160);
const fieldDescription = z.string().max(2000);
const enumValues = z
  .array(z.string().max(160))
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length, {
    message: 'The choices contain duplicates.',
  });
const lengthLimit = z.number().int().min(0).max(LIMITS.answerStringLength);
const finite = z.number().refine(Number.isFinite, { message: 'The number must be finite.' });

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
        { message: `There must be 1 to ${String(LIMITS.questionFields)} fields.` },
      ),
      required: z.array(fieldNameSchema).max(LIMITS.questionFields),
      additionalProperties: z.literal(false),
    }),
  })
  .superRefine((questionnaire, context) => {
    const names = Object.keys(questionnaire.answerSchema.properties);
    const order = questionnaire.fieldOrder;
    if (new Set(order).size !== order.length) {
      context.addIssue({ code: 'custom', path: ['fieldOrder'], message: 'There are duplicates.' });
    }
    if (order.length !== names.length || !names.every((name) => order.includes(name))) {
      context.addIssue({
        code: 'custom',
        path: ['fieldOrder'],
        message: 'The fields in fieldOrder and properties do not match.',
      });
    }
    const { required } = questionnaire.answerSchema;
    if (new Set(required).size !== required.length) {
      context.addIssue({
        code: 'custom',
        path: ['answerSchema', 'required'],
        message: 'There are duplicates.',
      });
    }
    for (const name of required) {
      if (!names.includes(name)) {
        context.addIssue({
          code: 'custom',
          path: ['answerSchema', 'required'],
          message: `The field ${name} does not exist.`,
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
      if (inverted)
        context.addIssue({
          code: 'custom',
          path,
          message: 'The lower bound is greater than the upper bound.',
        });
      if (
        field.type === 'array' &&
        field.minItems !== undefined &&
        field.minItems > field.items.enum.length
      ) {
        context.addIssue({
          code: 'custom',
          path,
          message: 'minItems is greater than the number of choices.',
        });
      }
    }
  });
export type Questionnaire = z.infer<typeof questionnaireSchema>;

// An answer value. An array of strings is an array of choices.
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
  // Field name. '' for an issue with the whole answer. Never includes the value (a secret written there must not leak into the error).
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

// Size in UTF-8. Counted from the characters so the browser and Node.js give the same value.
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

// Validate answers (spec 11.2). With complete, validate for submit (also checks required and minimum constraints);
// otherwise validate a draft answer (allows an incomplete answer and checks only the type, value and size of the fields present).
// No type coercion. Returns an empty array when there are no issues.
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
    // Contains a value JSON cannot represent (undefined or a non-finite number).
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
  // The revision answered (the revision pinned when the question was created).
  revision: revisionSchema,
  // Whether it was submitted as an answer to the pinned revision after confirming a newer revision exists.
  confirmedAgainstOlderRevision: z.boolean(),
  // The document's current revision as confirmed at submit time.
  currentRevisionAtSubmit: revisionSchema.nullable(),
});
export type Submission = z.infer<typeof submissionSchema>;

export const cancellationSchema = z.strictObject({
  cancelledAt: z.string(),
  reason: cancellationReasonSchema,
});

// Question state returned to the agent. Excludes the draft answer (spec 11.3). Only the submitted answer is returned.
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

// Question state returned to the management UI. Includes the question definition, the draft answer and the document's current revision.
export const feedbackForUiSchema = feedbackForAgentSchema.extend({
  questionnaire: questionnaireSchema,
  // The HTML mode pinned when the question was created. With interactive, the HTML can send draft answers.
  renderMode: htmlModeSchema,
  draftVersion: z.number().int().nonnegative(),
  draftAnswers: answersSchema,
  // The document's current revision. If it differs from the pinned revision, a newer revision exists.
  currentRevision: revisionSchema.nullable(),
  documentOpen: z.boolean(),
});
export type FeedbackForUi = z.infer<typeof feedbackForUiSchema>;

export const feedbackCreateParamsSchema = z
  .strictObject({
    cwd: z.string().min(1),
    // Raw JSON text of the question definition. The daemon parses the raw text to detect duplicate keys.
    questionnaire: z.string(),
    // Ask about an already open document.
    documentId: documentIdSchema.optional(),
    revision: revisionSchema.optional(),
    // Open a document, then ask about that revision.
    view: z.string().min(1).optional(),
    htmlMode: htmlModeSchema.optional(),
    assetsRoot: z.string().min(1).optional(),
    assets: z.array(z.string().min(1)).max(LIMITS.documentAssets).default([]),
    // Identifier that keeps a retry from creating the same question twice.
    operationId: z.uuid().optional(),
  })
  .superRefine((params, context) => {
    if (params.documentId !== undefined && params.view !== undefined) {
      context.addIssue({
        code: 'custom',
        message: '--document and --view cannot be used together.',
      });
    }
    if (params.revision !== undefined && params.documentId === undefined) {
      context.addIssue({ code: 'custom', message: '--revision requires --document.' });
    }
    const viewOnly =
      params.htmlMode !== undefined || params.assetsRoot !== undefined || params.assets.length > 0;
    if (viewOnly && params.view === undefined) {
      context.addIssue({
        code: 'custom',
        message:
          '--html-mode, --assets-root and --asset apply only to a document newly opened with --view.',
      });
    }
  });
export type FeedbackCreateParams = z.input<typeof feedbackCreateParamsSchema>;

export const feedbackCreateResultSchema = z.strictObject({
  request: feedbackForAgentSchema,
  // Whether a resend with the same operation ID returned the previously created question.
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
  // Maximum time to wait. The CLI passes the remaining time.
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
  // Explicit confirmation to delete (`--yes`).
  confirmed: z.boolean(),
});

export const feedbackDraftParamsSchema = z.strictObject({
  expectedDraftVersion: z.number().int().nonnegative(),
  answers: z.unknown(),
});

export const feedbackSubmitParamsSchema = z.strictObject({
  submissionId: submissionIdSchema,
  expectedDraftVersion: z.number().int().nonnegative(),
  // The revision pinned when the question was created.
  revision: revisionSchema,
  // The document's current revision as confirmed on the submit screen.
  currentRevision: revisionSchema.nullable(),
  // Submit as an answer to the pinned revision after confirming a newer revision exists. Set only by an action in the management UI.
  confirmOlderRevision: z.boolean().default(false),
});
export type FeedbackSubmitParams = z.input<typeof feedbackSubmitParamsSchema>;

export const feedbackCancelParamsSchema = z.strictObject({
  // Confirmation of the cancel (confirmed in the management UI).
  confirmed: z.literal(true),
});
