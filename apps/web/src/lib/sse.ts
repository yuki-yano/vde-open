// SSE parsing for streams read with fetch (spec 6.5). Handles multi-line data, UTF-8 split across chunks, CRLF,
// and comment heartbeats.

export interface SseMessage {
  event: string;
  data: string;
  id: string | null;
}

export interface SseParser {
  push(chunk: Uint8Array): void;
}

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | null = null;

  const dispatch = () => {
    if (data.length > 0)
      onMessage({ event: event === '' ? 'message' : event, data: data.join('\n'), id });
    event = '';
    data = [];
  };

  const handleLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    // Lines starting with `:` are comments (heartbeats).
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  };

  return {
    push(chunk) {
      // With stream: true, a character split at a chunk boundary carries over to the next chunk.
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        // A trailing CR is not finalized, since the next chunk may start with LF.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        handleLine(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
  };
}
