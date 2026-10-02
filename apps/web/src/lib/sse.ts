// fetchで読むSSEの解析（仕様6.5）。複数行のdata、chunkの途中で切れたUTF-8、CRLF、
// commentのheartbeatを扱う。

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
    // `:`で始まる行はcomment（heartbeat）。
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
      // stream: trueで、chunkの境界で切れた文字を次のchunkへ持ち越す。
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        // 末尾のCRは、次のchunkがLFで始まるかもしれないので確定させない。
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        handleLine(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
  };
}
