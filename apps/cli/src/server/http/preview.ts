import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { isValidLogicalPath } from '@vde-open/document';

import type { HtmlMode } from '@vde-open/shared';

import type { PreviewFile, RenderService } from '../../render/render-service.ts';

const CLOSE_GRACE_MS = 1000;
// 表示用URLの形。`/r/<grant>/files/<logical path>`だけを受け付ける（仕様12.3）。
const PREVIEW_PATH = /^\/r\/([A-Za-z0-9_-]{43})\/files\/(.+)$/;
const ENCODED_SEPARATOR_OR_NUL = /%(2f|5c|00)/i;

export interface PreviewDeps {
  render: RenderService;
  // 表示を埋め込める管理UIのorigin。開発用のoriginがあれば、それも含む。
  frameAncestors: () => string[];
  onEvent?: (event: string, fields: Record<string, string | number>) => void;
}

export interface PreviewServer {
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

// 文書のpolicy（仕様10.5）。読み込めるのは、この表示に登録したfileだけ。
// staticはscriptを動かさない。interactiveは、inlineと登録済みのscriptと、登録済みのfileへの通信だけを許す。
// どちらも`allow-same-origin`を付けない（originを持たない）。
function documentCsp(mode: HtmlMode, grantBase: string, ancestors: string[]): string {
  const interactive = mode === 'interactive';
  return [
    "default-src 'none'",
    interactive ? `script-src 'unsafe-inline' ${grantBase}` : "script-src 'none'",
    `style-src 'unsafe-inline' ${grantBase}`,
    `img-src ${grantBase} data:`,
    `font-src ${grantBase}`,
    interactive ? `connect-src ${grantBase}` : "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors.length > 0 ? ancestors.join(' ') : "'none'"}`,
    interactive ? 'sandbox allow-scripts' : 'sandbox',
  ].join('; ');
}

// asset単体のpolicy。直接開かれても、何も読み込まず、何も実行しない。
const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function headersFor(file: PreviewFile, origin: string, ancestors: string[]) {
  const headers: Record<string, string> = {
    'Content-Type': file.mime,
    'Content-Length': String(file.body.byteLength),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      file.role === 'document'
        ? documentCsp(file.mode, `${origin}/r/${file.grant}/`, ancestors)
        : ASSET_CSP,
  };
  // sandboxの中の文書はoriginを持たないので、fontなどの読み込みはcross-originになる。
  // 権限を確かめた後のassetにだけ許可する。文書そのものと画像には付けない。
  // この`null`は、読み込みを許可するためだけのもので、相手の確認には使わない。
  if (
    file.role === 'font' ||
    file.role === 'style' ||
    file.role === 'script' ||
    file.role === 'data'
  ) {
    headers['Access-Control-Allow-Origin'] = 'null';
  }
  return headers;
}

function logicalPathOf(encoded: string): string | null {
  // 区切りやNULをencodeした形は、解釈が分かれるので受け付けない。
  if (ENCODED_SEPARATOR_OR_NUL.test(encoded)) return null;
  const segments: string[] = [];
  for (const segment of encoded.split('/')) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  const logicalPath = segments.join('/');
  return isValidLogicalPath(logicalPath) ? logicalPath : null;
}

export async function startPreviewServer(
  deps: PreviewDeps,
  options: { port?: number } = {},
): Promise<PreviewServer> {
  let origin = '';
  let host = '';

  const reject = (response: ServerResponse, status: number, extra: Record<string, string> = {}) => {
    // 理由を区別しない。権限が無効でも、pathが未登録でも、同じ応答を返す。
    const body = status === 405 ? 'Method Not Allowed' : 'Not Found';
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      ...extra,
    });
    response.end(body);
    // 表示用URLは秘密を含むので、pathは記録しない。
    deps.onEvent?.('preview.rejected', { status });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Hostは実際のlisten先だけを受け付ける。
    if (request.headers.host !== host) return reject(response, 404);
    const method = request.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') return reject(response, 405, { Allow: 'GET, HEAD' });

    // `..`や`%2e%2e`は、URLとして解決した後の形で調べる。browserが解決する形と同じ。
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '', origin).pathname;
    } catch {
      return reject(response, 404);
    }
    const match = PREVIEW_PATH.exec(pathname);
    const logicalPath = match ? logicalPathOf(match[2] as string) : null;
    if (!match || logicalPath === null) return reject(response, 404);

    const file = await deps.render.resolve(match[1] as string, logicalPath);
    if (!file) return reject(response, 404);
    response.writeHead(200, headersFor(file, origin, deps.frameAncestors()));
    response.end(method === 'HEAD' ? undefined : file.body);
    deps.onEvent?.('preview.served', { bytes: file.body.byteLength });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else reject(response, 404);
    });
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${String(port)}`;
  origin = `http://${host}`;

  return {
    port,
    origin,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS).unref();
      });
    },
  };
}
