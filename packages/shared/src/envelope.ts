import { z } from 'zod';

import { CLI_SCHEMA_VERSION } from './versions.ts';

const detailsSchema = z.record(z.string(), z.unknown());

export const warningSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  details: detailsSchema.optional(),
});
export type Warning = z.infer<typeof warningSchema>;

export const errorBodySchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: detailsSchema,
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

export const envelopeMetaSchema = z.strictObject({
  command: z.string().min(1),
  catalogVersion: z.number().int().nonnegative().optional(),
});
export type EnvelopeMeta = z.infer<typeof envelopeMetaSchema>;

export const successEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(CLI_SCHEMA_VERSION),
  ok: z.literal(true),
  data: z.unknown(),
  warnings: z.array(warningSchema),
  meta: envelopeMetaSchema,
});

export const errorEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(CLI_SCHEMA_VERSION),
  ok: z.literal(false),
  error: errorBodySchema,
  warnings: z.array(warningSchema),
});

export const envelopeSchema = z.discriminatedUnion('ok', [
  successEnvelopeSchema,
  errorEnvelopeSchema,
]);

export interface SuccessEnvelope<T> {
  schemaVersion: typeof CLI_SCHEMA_VERSION;
  ok: true;
  data: T;
  warnings: Warning[];
  meta: EnvelopeMeta;
}

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function successEnvelope<T>(
  data: T,
  meta: EnvelopeMeta,
  warnings: Warning[] = [],
): SuccessEnvelope<T> {
  return { schemaVersion: CLI_SCHEMA_VERSION, ok: true, data, warnings, meta };
}

export function errorEnvelope(error: ErrorBody, warnings: Warning[] = []): ErrorEnvelope {
  return { schemaVersion: CLI_SCHEMA_VERSION, ok: false, error, warnings };
}
