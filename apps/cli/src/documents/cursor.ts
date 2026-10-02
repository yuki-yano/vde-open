import { createHmac, timingSafeEqual } from 'node:crypto';

import { LIMITS, VdeError } from '@vde-open/shared';

// serverが発行する署名付きcursor（仕様9.4）。payloadは操作と条件を拘束し、
// 別の操作や条件へ流用できない。secretはdaemonの起動ごとに作るので、再起動で失効する。
export interface CursorCodec {
  encode(payload: Record<string, unknown>): string;
  decode(token: string, operation: string): Record<string, unknown>;
}

function invalidCursor(reason: string): VdeError {
  return new VdeError(
    'E_INVALID_CURSOR',
    'cursorが正しくないか、期限が切れています。最初から取得し直してください。',
    { reason },
  );
}

export function createCursorCodec(secret: Buffer, now: () => number = Date.now): CursorCodec {
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('base64url');
  return {
    encode(payload) {
      const body = Buffer.from(
        JSON.stringify({ ...payload, exp: now() + LIMITS.cursorTtlMs }),
        'utf8',
      ).toString('base64url');
      return `${body}.${sign(body)}`;
    },
    decode(token, operation) {
      const [body, signature, ...rest] = token.split('.');
      if (!body || !signature || rest.length > 0) throw invalidCursor('malformed');
      const expected = Buffer.from(sign(body), 'base64url');
      const actual = Buffer.from(signature, 'base64url');
      if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
        throw invalidCursor('signature');
      }
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      if (typeof payload['exp'] !== 'number' || payload['exp'] < now())
        throw invalidCursor('expired');
      if (payload['op'] !== operation) throw invalidCursor('operation');
      return payload;
    },
  };
}
