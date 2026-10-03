// IPC wire format. UTF-8 NDJSON, where one frame is one JSON object (spec 6.3).

export type FrameErrorKind = 'too-large' | 'invalid-json' | 'not-an-object';

export class FrameError extends Error {
  readonly kind: FrameErrorKind;

  constructor(kind: FrameErrorKind) {
    super(`Invalid IPC frame: ${kind}`);
    this.name = 'FrameError';
    this.kind = kind;
  }
}

const NEWLINE = 0x0a;

export function encodeFrame(value: unknown): Buffer {
  // JSON.stringify escapes newlines inside strings, so a frame never contains a raw newline.
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

export class FrameDecoder {
  readonly #limit: () => number;
  #chunks: Buffer[] = [];
  #size = 0;

  // The limit differs before and after authentication, so query it each time.
  constructor(limit: () => number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    let rest = chunk;
    while (rest.byteLength > 0) {
      const newline = rest.indexOf(NEWLINE);
      if (newline === -1) {
        this.#append(rest);
        break;
      }
      this.#append(rest.subarray(0, newline));
      frames.push(this.#parse(Buffer.concat(this.#chunks, this.#size)));
      this.#chunks = [];
      this.#size = 0;
      rest = rest.subarray(newline + 1);
    }
    return frames;
  }

  #append(part: Buffer): void {
    if (this.#size + part.byteLength > this.#limit()) throw new FrameError('too-large');
    if (part.byteLength === 0) return;
    this.#chunks.push(part);
    this.#size += part.byteLength;
  }

  #parse(bytes: Buffer): Record<string, unknown> {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new FrameError('invalid-json');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new FrameError('not-an-object');
    }
    return value as Record<string, unknown>;
  }
}
