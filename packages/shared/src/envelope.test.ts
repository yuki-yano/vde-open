import { describe, expect, it } from 'vitest';

import { envelopeSchema, errorEnvelope, successEnvelope } from './envelope.ts';

describe('CLI JSON envelope', () => {
  it('成功envelopeは仕様5.6の形で、schemaで検証できる', () => {
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

  it('失敗envelopeはerrorを持ち、dataとmetaを持たない', () => {
    const envelope = errorEnvelope({
      code: 'E_REVISION_UNAVAILABLE',
      message: '指定した版は保持されていません。',
      retryable: false,
      details: {},
    });
    expect(envelopeSchema.parse(envelope)).toEqual(envelope);
    expect(Object.keys(envelope).toSorted()).toEqual(['error', 'ok', 'schemaVersion', 'warnings']);
  });

  it('未知のkeyや別のschemaVersionを受け付けない', () => {
    const base = successEnvelope(null, { command: 'list' });
    expect(envelopeSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(envelopeSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
  });
});
