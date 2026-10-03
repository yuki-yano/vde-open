import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { isValidLogicalPath } from '@vde-open/document';

import type { HtmlMode } from '@vde-open/shared';

import type { PreviewFile, RenderService } from '../../render/render-service.ts';

const CLOSE_GRACE_MS = 1000;
// Shape of a view URL. Only `/r/<grant>/files/<logical path>` is accepted (spec 12.3).
const PREVIEW_PATH = /^\/r\/([A-Za-z0-9_-]{43})\/files\/(.+)$/;
const ENCODED_SEPARATOR_OR_NUL = /%(2f|5c|00)/i;

export interface PreviewDeps {
  render: RenderService;
  // Management UI origins allowed to embed the view. Includes the development origin, if any.
  frameAncestors: () => string[];
  onEvent?: (event: string, fields: Record<string, string | number>) => void;
}

export interface PreviewServer {
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

// Document policy (spec 10.5). Only files registered for this view may be loaded.
// static runs no scripts. interactive allows only inline and registered scripts, and connections to registered files.
// Neither adds `allow-same-origin` (the document has no origin).
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

// Policy for a standalone asset. Even if opened directly, it loads nothing and runs nothing.
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
  // A sandboxed document has no origin, so loading fonts and the like is cross-origin.
  // Allow it only for assets after the grant is verified. Not added to the document itself or to images.
  // This `null` only permits loading; it is not used to verify the peer.
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
  // Encoded separators and NUL are interpreted inconsistently, so they are not accepted.
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
    // Do not distinguish the reason. An invalid grant and an unregistered path get the same response.
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
    // View URLs contain a secret, so the path is not logged.
    deps.onEvent?.('preview.rejected', { status });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Accept only the actual listen address as Host.
    if (request.headers.host !== host) return reject(response, 404);
    const method = request.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') return reject(response, 405, { Allow: 'GET, HEAD' });

    // `..` and `%2e%2e` are checked in the form after URL resolution. Same as how the browser resolves them.
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
