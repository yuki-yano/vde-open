import { request as httpRequest } from 'node:http';

import type { TestHome } from './harness.ts';

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
}

export interface RawOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

// Sends a request without normalizing the URL, so that `..` and encoded separators arrive as written.
export function rawRequest(
  origin: string,
  path: string,
  options: RawOptions = {},
): Promise<RawResponse> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
            text: body.toString('utf8'),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

export interface Envelope<T> {
  ok: boolean;
  data: T;
  error: { code: string; message: string; details: Record<string, unknown> };
}

export interface GrantData {
  grant: string;
  revision: string;
  documentUrl: string | null;
  filesBaseUrl: string;
  documentLogicalPath: string;
  assets: Array<{ logicalPath: string; role: string }>;
  links: Array<{ linkId: string; href: string; text: string; kind: string }>;
  diagnostics: Array<{ code: string; target: string | null; count: number }>;
}

export interface UiClient {
  // Origin of the management UI.
  origin: string;
  // Origin of the listener that serves documents.
  previewOrigin: string;
  token: string;
  // Calls the management API with authentication.
  api: <T>(
    path: string,
    options?: { method?: string; body?: unknown },
  ) => Promise<{ status: number; json: Envelope<T>; headers: RawResponse['headers'] }>;
  grant: (documentId: string, revision?: string) => Promise<GrantData>;
  // Path part of the preview URL (`/r/<grant>/files/`).
  filesPath: (grant: GrantData) => string;
}

// Creates a management UI session from the one-time URL issued by the CLI.
export async function connectUi(t: TestHome): Promise<UiClient> {
  const status = (await t.run(['daemon', 'status', '--json'])).json<{ uiUrl: string }>();
  const origin = status.data.uiUrl.replace(/\/$/, '');
  const printed = await t.run(['ui', '--print-url']);
  const ticket = printed.stdout.trim().split('#bootstrap=')[1] as string;
  const exchanged = await rawRequest(origin, '/_/api/v1/sessions/bootstrap', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  const token = (JSON.parse(exchanged.text) as Envelope<{ token: string }>).data.token;

  const api: UiClient['api'] = async (path, options = {}) => {
    const response = await rawRequest(origin, `/_/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: origin,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return {
      status: response.status,
      json: JSON.parse(response.text) as Envelope<never>,
      headers: response.headers,
    };
  };
  const { previewOrigin } = (await api<{ previewOrigin: string }>('/status')).json.data;

  return {
    origin,
    previewOrigin,
    token,
    api,
    async grant(documentId, revision) {
      const response = await api<GrantData>(`/documents/${documentId}/render-grants`, {
        method: 'POST',
        body: revision === undefined ? {} : { revision },
      });
      if (!response.json.ok) {
        throw new Error(`cannot get a grant: ${JSON.stringify(response.json.error)}`);
      }
      return response.json.data;
    },
    filesPath: (grant) => new URL(grant.filesBaseUrl).pathname,
  };
}
