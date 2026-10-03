import { describe, expect, it } from 'vitest';

import { envelopeSchema, errorEnvelope, successEnvelope } from './envelope.ts';

describe('CLI JSON envelope', () => {
  it('a success envelope has the shape of spec 5.6 and validates against the schema', () => {
    const envelope = successEnvelope({ documents: [] }, { command: 'list', catalogVersion: 12 });
    expect(envelope).toEqual({
      schemaVersion: 1,
      ok: true,
      data: { documents: [] },
      warnings: [],
      meta: { command: 'list', catalogVersion: 12 },
    });
    expect(envelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('an error envelope has error and has neither data nor meta', () => {
    const envelope = errorEnvelope({
      code: 'E_REVISION_UNAVAILABLE',
      message: 'The requested revision is no longer retained.',
      retryable: false,
      details: {},
    });
    expect(envelopeSchema.parse(envelope)).toEqual(envelope);
    expect(Object.keys(envelope).toSorted()).toEqual(['error', 'ok', 'schemaVersion', 'warnings']);
  });

  it('rejects unknown keys and a different schemaVersion', () => {
    const base = successEnvelope(null, { command: 'list' });
    expect(envelopeSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(envelopeSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
  });
});
