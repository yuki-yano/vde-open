import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { IPC_PROTOCOL_VERSION } from '@vde-open/shared';

export const IPC_KEY_BYTES = 32;
export const NONCE_BYTES = 32;
export const HANDSHAKE_TIMEOUT_MS = 5000;

export type ProofRole = 'server' | 'client';

export function createNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64');
}

export function isNonce(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  return Buffer.from(value, 'base64').byteLength >= NONCE_BYTES;
}

// Mutual verification on the same stream (spec 6.3). The key itself never goes on the wire.
export function computeProof(
  key: Buffer,
  role: ProofRole,
  daemonId: string,
  clientNonce: string,
  serverNonce: string,
): string {
  return createHmac('sha256', key)
    .update(JSON.stringify([role, IPC_PROTOCOL_VERSION, daemonId, clientNonce, serverNonce]))
    .digest('hex');
}

export function proofMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  if (expectedBytes.byteLength !== actualBytes.byteLength) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}
