import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCursorCodec } from './cursor.ts';

describe('signed cursor', () => {
  it('decodes the issued payload only for the same operation', () => {
    const codec = createCursorCodec(randomBytes(32));
    const token = codec.encode({ op: 'list', offset: 2, catalogVersion: 5 });
    expect(codec.decode(token, 'list')).toMatchObject({ offset: 2, catalogVersion: 5 });
    expect(() => codec.decode(token, 'read')).toThrowError(
      expect.objectContaining({ code: 'E_INVALID_CURSOR', details: { reason: 'operation' } }),
    );
  });

  it('rejects tampering, another secret, and expiry', () => {
    let now = 1_000_000;
    const codec = createCursorCodec(randomBytes(32), () => now);
    const token = codec.encode({ op: 'list', offset: 0 });
    const [body, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ op: 'list', offset: 999, exp: now + 1000 }),
    ).toString('base64url');

    expect(() => codec.decode(`${forged}.${signature}`, 'list')).toThrowError(
      expect.objectContaining({ details: { reason: 'signature' } }),
    );
    expect(() => codec.decode(body, 'list')).toThrowError(
      expect.objectContaining({ details: { reason: 'malformed' } }),
    );
    expect(() => createCursorCodec(randomBytes(32)).decode(token, 'list')).toThrowError(
      expect.objectContaining({ code: 'E_INVALID_CURSOR' }),
    );

    now += 5 * 60 * 1000 + 1;
    expect(() => codec.decode(token, 'list')).toThrowError(
      expect.objectContaining({ details: { reason: 'expired' } }),
    );
  });
});
