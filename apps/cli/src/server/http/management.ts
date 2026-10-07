import { readdir, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';

import { serve, type HttpBindings } from '@hono/node-server';
import {
  errorEnvelope,
  ExitCode,
  exitCodeForError,
  feedbackCancelParamsSchema,
  isVdeError,
  LIMITS,
  linkOpenParamsSchema,
  parseStrictJson,
  requestIdSchema,
  revisionSchema,
  StrictJsonError,
  successEnvelope,
  VdeError,
  type ErrorBody,
  type ServerEvent,
  type UiStatus,
} from '@vde-open/shared';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z, ZodError } from 'zod';

import type { DocumentService, ServiceResult } from '../../documents/service.ts';
import type { PdfService } from '../../export/pdf-service.ts';
import type { FeedbackService } from '../../feedback/service.ts';
import type { RenderService } from '../../render/render-service.ts';
import type { SearchService } from '../../search/search-service.ts';
import type { EventHub } from '../event-hub.ts';
import type { SessionService } from '../session-service.ts';
import { createEventQueue } from './event-queue.ts';

const API_PREFIX = '/_/api/v1';
const STREAM_FLUSH_MS = 100;
const CLOSE_GRACE_MS = 1000;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// Management UI policy (spec 10.5). Scripts are only the bundled ones. API connections only to its own origin.
// Only the document view (iframe) and registered images in the document may load from the preview listener.
function uiCsp(previewOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${previewOrigin}`,
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    `frame-src ${previewOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export interface ManagementDeps {
  daemonId: string;
  version: string;
  documents: DocumentService;
  sessions: SessionService;
  events: EventHub;
  render: RenderService;
  search: SearchService;
  feedback: FeedbackService;
  pdf: PdfService;
  // Origin of the listener that serves documents.
  previewOrigin: string;
  // Directory of the built UI. If absent, the UI is not served.
  webRoot: string | null;
  // UI origin allowed only during development. Always null in distributed builds.
  devOrigin: string | null;
  isStopping: () => boolean;
  onEvent?: (event: string, fields: Record<string, string | number>) => void;
  // Interval for checking notification connections. Defaults to 15 seconds (spec 6.5).
  heartbeatMs?: number;
  // Time until a notification connection whose writes make no progress is cut. Defaults to `LIMITS.sseStallMs`.
  stallMs?: number;
}

export interface ManagementServer {
  readonly port: number;
  readonly origin: string;
  // Number of notification connections and the maximum pending notifications per connection (for diagnostics).
  eventStreams(): { streams: number; maxPending: number };
  close(): Promise<void>;
}

interface HttpEnv {
  Bindings: Partial<HttpBindings>;
  Variables: { token: string };
}

interface StaticAsset {
  body: Buffer;
  type: string;
  immutable: boolean;
}

async function loadStaticAssets(webRoot: string | null): Promise<Map<string, StaticAsset>> {
  const assets = new Map<string, StaticAsset>();
  if (!webRoot) return assets;
  // Fix the set of served files at startup. Request paths are never resolved against the filesystem.
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const urlPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, urlPath);
      else if (entry.isFile()) {
        assets.set(urlPath, {
          body: await readFile(path),
          type: MIME_TYPES[extname(entry.name).toLowerCase()] ?? 'application/octet-stream',
          immutable: prefix.startsWith('/assets'),
        });
      }
    }
  };
  await walk(webRoot, '');
  const index = assets.get('/index.html');
  if (index) assets.set('/', index);
  return assets;
}

// Body containing a draft answer. Read from the raw text to reject duplicate keys and `__proto__` (ADR-0011).
function parseAnswersBody(text: string): unknown {
  try {
    return parseStrictJson(text);
  } catch (error) {
    if (!(error instanceof StrictJsonError)) throw error;
    throw new VdeError('E_INVALID_ARGUMENT', 'The draft answer could not be parsed as JSON.', {
      reason: error.reason,
      pointer: error.pointer,
    });
  }
}

function toErrorBody(error: unknown): ErrorBody {
  if (isVdeError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  if (error instanceof ZodError) {
    return {
      code: 'E_INVALID_ARGUMENT',
      message: 'The arguments are invalid.',
      retryable: false,
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  }
  // Do not return the details of unexpected exceptions to the peer.
  return {
    code: 'E_INTERNAL',
    message: 'An internal error occurred.',
    retryable: false,
    details: {},
  };
}

// Decide the HTTP status from the error code (spec 12.2). Clients act on the code in the body.
function statusOf(code: string): ContentfulStatusCode {
  if (code === 'E_UNAUTHORIZED') return 401;
  if (code === 'E_UNKNOWN_METHOD') return 404;
  if (code === 'E_DAEMON_STOPPING') return 503;
  switch (exitCodeForError(code)) {
    case ExitCode.usage:
      return 400;
    case ExitCode.notFound:
      return 404;
    case ExitCode.conflict:
      return 409;
    case ExitCode.forbidden:
      return 403;
    case ExitCode.timeout:
      return 408;
    case ExitCode.limit:
      return 413;
    case ExitCode.daemon:
      return 503;
    default:
      return 500;
  }
}

function fail(c: Context, error: unknown) {
  const body = toErrorBody(error);
  return c.json(errorEnvelope(body), statusOf(body.code));
}

function ok<T>(c: Context, command: string, result: ServiceResult<T>) {
  return c.json(
    successEnvelope(
      result.data,
      { command, catalogVersion: result.catalogVersion },
      result.warnings,
    ),
  );
}

const linesQuerySchema = z
  .string()
  .regex(/^\d+:\d+$/)
  .transform((value) => {
    const [start, end] = value.split(':').map(Number) as [number, number];
    return { start, end };
  });

const integerQuery = z.string().regex(/^\d+$/).transform(Number);

export async function startManagementServer(
  deps: ManagementDeps,
  options: { port?: number } = {},
): Promise<ManagementServer> {
  const assets = await loadStaticAssets(deps.webRoot);
  const app = new Hono<HttpEnv>();
  let origin = '';
  let host = '';
  // Per notification connection: the finish function and the number of pending notifications.
  const streams = new Map<() => void, { readonly pending: number }>();

  // Headers attached to every response.
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  // Accept only the actual listen address as Host. Reject requests arriving under another name (DNS rebinding).
  app.use('*', async (c, next) => {
    if (c.req.header('host') !== host) {
      deps.onEvent?.('http.rejected', { reason: 'host' });
      return fail(c, new VdeError('E_UNAUTHORIZED', 'This Host is not allowed.'));
    }
    return next();
  });

  app.use(`${API_PREFIX}/*`, async (c, next) => {
    const requestOrigin = c.req.header('origin');
    const allowed =
      requestOrigin === origin || (deps.devOrigin !== null && requestOrigin === deps.devOrigin);
    // If Origin is present, reject unless it is this UI's origin. `null` is not treated as a management principal either.
    if (requestOrigin !== undefined && !allowed) {
      deps.onEvent?.('http.rejected', { reason: 'origin' });
      return fail(c, new VdeError('E_UNAUTHORIZED', 'This Origin is not allowed.'));
    }
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && !(deps.devOrigin !== null && allowed)) {
      deps.onEvent?.('http.rejected', { reason: 'fetch-site' });
      return fail(c, new VdeError('E_UNAUTHORIZED', 'This request is not accepted.'));
    }
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') {
      // State-changing requests are limited to fetches from the UI. Use conditions a form submission cannot produce.
      if (requestOrigin === undefined) {
        return fail(
          c,
          new VdeError('E_UNAUTHORIZED', 'A request without Origin cannot make changes.'),
        );
      }
      const contentLength = Number(c.req.header('content-length') ?? '0');
      if (
        contentLength > 0 &&
        !(c.req.header('content-type') ?? '').startsWith('application/json')
      ) {
        return fail(c, new VdeError('E_INVALID_ARGUMENT', 'The body must be sent as JSON.'));
      }
    }
    if (deps.isStopping()) {
      return fail(c, new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.'));
    }
    // Only the ticket exchange at the entry point is accepted without a session.
    if (c.req.path === `${API_PREFIX}/sessions/bootstrap` && method === 'POST') return next();
    const authorization = c.req.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (token === '' || !deps.sessions.authenticate(token)) {
      return fail(
        c,
        new VdeError('E_UNAUTHORIZED', 'Authentication is required. Open again from the CLI.'),
      );
    }
    c.set('token', token);
    return next();
  });

  const api = new Hono<HttpEnv>();

  api.post('/sessions/bootstrap', async (c) => {
    const body = z.strictObject({ ticket: z.string().min(1).max(256) }).parse(await c.req.json());
    const token = deps.sessions.exchange(body.ticket);
    if (!token) {
      return fail(
        c,
        new VdeError('E_UNAUTHORIZED', 'This URL has already been used or has expired.'),
      );
    }
    return c.json(
      successEnvelope(
        { token, idleTimeoutSeconds: LIMITS.sessionIdleMs / 1000 },
        { command: 'sessions.bootstrap' },
      ),
    );
  });

  api.delete('/session', (c) => {
    deps.sessions.revoke(c.get('token'));
    return c.json(successEnvelope({ revoked: true }, { command: 'session.delete' }));
  });

  api.get('/status', (c) => {
    const state = deps.documents.state;
    const status: UiStatus = {
      version: deps.version,
      daemonId: deps.daemonId,
      catalogVersion: state.catalogVersion,
      activeDocumentId: state.activeDocumentId,
      openDocuments: state.openOrder.length,
      previewOrigin: deps.previewOrigin,
    };
    return c.json(
      successEnvelope(status, { command: 'status', catalogVersion: state.catalogVersion }),
    );
  });

  api.get('/documents', (c) => {
    const limit = c.req.query('limit');
    const cursor = c.req.query('cursor');
    return ok(
      c,
      'documents.list',
      deps.documents.list({
        ...(limit === undefined ? {} : { limit: integerQuery.parse(limit) }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
  });

  api.get('/documents/:id/content', async (c) => {
    const { revision, lines, section, maxBytes, cursor } = c.req.query();
    return ok(
      c,
      'documents.read',
      await deps.documents.read({
        documentId: c.req.param('id'),
        ...(revision === undefined ? {} : { revision }),
        ...(section === undefined ? {} : { section }),
        ...(lines === undefined ? {} : { lines: linesQuerySchema.parse(lines) }),
        ...(maxBytes === undefined ? {} : { maxBytes: integerQuery.parse(maxBytes) }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
  });

  api.get('/documents/:id/outline', async (c) => {
    const { revision, maxBytes, cursor } = c.req.query();
    const result = await deps.documents.read({
      documentId: c.req.param('id'),
      // Continuation is fetched by cursor alone (the cursor is fixed to the revision and read kind it was issued for).
      ...(cursor === undefined ? { outline: true } : { cursor }),
      ...(revision === undefined ? {} : { revision }),
      ...(maxBytes === undefined ? {} : { maxBytes: integerQuery.parse(maxBytes) }),
    });
    if (result.data.mode !== 'outline') {
      throw new VdeError('E_INVALID_CURSOR', 'The cursor is not for an outline.', {
        reason: 'mode',
      });
    }
    return ok(c, 'documents.outline', result);
  });

  api.put('/documents/order', async (c) =>
    ok(c, 'documents.reorder', await deps.documents.reorder(await c.req.json())),
  );

  api.delete('/documents/:id', async (c) =>
    ok(
      c,
      'documents.close',
      // The UI closes by ID only. There is no API that accepts a path.
      await deps.documents.close({ cwd: '/', targets: [c.req.param('id')], all: false }),
    ),
  );

  api.post('/documents/:id/focus', async (c) =>
    ok(c, 'documents.focus', await deps.documents.focus({ documentId: c.req.param('id') })),
  );

  api.post('/documents/:id/refresh', async (c) =>
    ok(c, 'documents.refresh', await deps.documents.refresh({ documentId: c.req.param('id') })),
  );

  // PDF of the shown revision of a document. The body is the PDF itself; failures use the JSON envelope.
  api.post('/documents/:id/pdf', async (c) => {
    const body = z.strictObject({ revision: revisionSchema }).parse(await c.req.json());
    // When the UI goes away (the request is aborted), the browser is stopped.
    const pdf = await deps.pdf.exportPdf(c.req.param('id'), body.revision, c.req.raw.signal);
    return c.body(new Uint8Array(pdf), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment',
    });
  });

  // Search over open documents. The accepted parameters are the same as the CLI (spec 12.2).
  api.get('/search', async (c) => {
    const { query, mode, limit, maxBytes, cursor } = c.req.query();
    const documents = c.req.queries('document') ?? [];
    return ok(
      c,
      'documents.search',
      await deps.search.search({
        query,
        documents,
        ...(mode === undefined ? {} : { mode }),
        ...(limit === undefined ? {} : { limit: integerQuery.parse(limit) }),
        ...(maxBytes === undefined ? {} : { maxBytes: integerQuery.parse(maxBytes) }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
  });

  // List of questions. Draft answers are not included.
  api.get('/feedback', (c) => {
    const status = c.req.query('status');
    return ok(c, 'feedback.list', deps.feedback.list(status === undefined ? {} : { status }));
  });

  // A question for the management UI. Includes the questionnaire, the draft answer, and the document's current revision.
  api.get('/feedback/:id', (c) =>
    ok(c, 'feedback.get', deps.feedback.getForUi(requestIdSchema.parse(c.req.param('id')))),
  );

  // Replace the draft answer. The body is read from the raw text to detect duplicate keys (spec 11.2).
  api.put('/feedback/:id/draft', async (c) => {
    const requestId = requestIdSchema.parse(c.req.param('id'));
    const body = parseAnswersBody(await c.req.text());
    return ok(c, 'feedback.draft', await deps.feedback.updateDraft(requestId, body));
  });

  // Render grant for the revision and HTML mode pinned by a pending question (spec 12.2).
  api.post('/feedback/:id/render-grants', async (c) => {
    const requestId = requestIdSchema.parse(c.req.param('id'));
    const result = await deps.render.createGrantForRequest(
      deps.sessions.idOf(c.get('token')),
      requestId,
      { origin: c.req.header('origin') ?? origin },
    );
    return c.json(
      successEnvelope(result, {
        command: 'feedback.render-grant',
        catalogVersion: deps.documents.state.catalogVersion,
      }),
    );
  });

  // Operations from the HTML SDK (fetching and replacing the draft answer). The management UI relays them from the view iframe.
  // The render grant is received in the body; every time, check that it is still valid, belongs to this session, and the question is pending.
  const bridgeOf = (token: string, grant: unknown) => {
    const found =
      typeof grant === 'string' ? deps.render.bridgeOf(deps.sessions.idOf(token), grant) : null;
    if (!found) {
      throw new VdeError(
        'E_RENDER_GRANT_INVALID',
        'The render grant has expired, so draft answers from the HTML are not accepted.',
      );
    }
    return found;
  };
  api.post('/render-grants/bridge/ready', async (c) => {
    const body = z.strictObject({ grant: z.string().min(1).max(128) }).parse(await c.req.json());
    const { requestId } = bridgeOf(c.get('token'), body.grant);
    return ok(c, 'render-grants.bridge-ready', deps.feedback.getForUi(requestId));
  });
  api.put('/render-grants/bridge/draft', async (c) => {
    const { grant, ...draft } = parseAnswersBody(await c.req.text()) as Record<string, unknown>;
    const token = c.get('token');
    const { requestId } = bridgeOf(token, grant);
    // While waiting its turn to save, the grant may be released, script permission revoked, or the session expired.
    // Re-check inside the save transaction that the grant for the same question is still valid.
    return ok(
      c,
      'render-grants.bridge-draft',
      await deps.feedback.updateDraft(requestId, draft, {
        authorize: () => {
          if (bridgeOf(token, grant).requestId !== requestId) {
            throw new VdeError('E_RENDER_GRANT_INVALID', 'The render grant has changed.');
          }
        },
      }),
    );
  });

  // Submit the saved draft answer as the answer. The answer itself is not accepted here (spec 11.8).
  api.post('/feedback/:id/submit', async (c) =>
    ok(
      c,
      'feedback.submit',
      await deps.feedback.submit(requestIdSchema.parse(c.req.param('id')), await c.req.json()),
    ),
  );

  // Cancel the question after confirmation in the management UI.
  api.post('/feedback/:id/cancel', async (c) => {
    feedbackCancelParamsSchema.parse(await c.req.json());
    return ok(
      c,
      'feedback.cancel',
      await deps.feedback.cancel({ requestId: c.req.param('id') }, 'user'),
    );
  });

  // Issue a limited grant for viewing one revision of a document. The grant is bound to the issuing session.
  api.post('/documents/:id/render-grants', async (c) => {
    const body = z
      .strictObject({ revision: z.string().optional(), mode: z.string().optional() })
      .parse(await c.req.json());
    // The Origin of state-changing requests was verified at the entry point to be the management UI's origin.
    // The HTML SDK only starts communicating with a parent of this origin.
    const result = await deps.render.createGrant(
      deps.sessions.idOf(c.get('token')),
      { documentId: c.req.param('id'), ...body },
      { origin: c.req.header('origin') ?? origin },
    );
    return c.json(
      successEnvelope(result, {
        command: 'documents.render-grant',
        catalogVersion: deps.documents.state.catalogVersion,
      }),
    );
  });

  // Unregistered files the view tried to load. The grant is passed in the body, not in the URL.
  api.post('/render-grants/missing', async (c) => {
    const body = z.strictObject({ grant: z.string().min(1).max(128) }).parse(await c.req.json());
    const missing = deps.render.missingOf(deps.sessions.idOf(c.get('token')), body.grant);
    return c.json(successEnvelope({ missing }, { command: 'render-grants.missing' }));
  });

  // Change the HTML mode. Switching to the interactive view (which runs scripts) requires confirmation (spec 10.2).
  api.post('/documents/:id/html-mode', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    return ok(
      c,
      'documents.html-mode',
      await deps.documents.setHtmlMode({ ...body, documentId: c.req.param('id') }),
    );
  });

  // Release grants whose views are no longer shown. Only grants issued by the caller's own session can be released.
  api.post('/render-grants/release', async (c) => {
    const body = z
      .strictObject({ grants: z.array(z.string().min(1).max(128)).max(256) })
      .parse(await c.req.json());
    const released = deps.render.release(deps.sessions.idOf(c.get('token')), body.grants);
    return c.json(successEnvelope({ released }, { command: 'render-grants.release' }));
  });

  // Open the local document a link in the document points to. The target is given by the ID of the link extracted during parsing.
  // Paths are never accepted directly from the client (spec 12.2).
  api.post('/documents/:id/links/:linkId/open', async (c) => {
    const params = linkOpenParamsSchema.parse({
      ...((await c.req.json()) as Record<string, unknown>),
      documentId: c.req.param('id'),
      linkId: c.req.param('linkId'),
    });
    const link = await deps.render.linkOf(params.documentId, params.revision, params.linkId);
    return ok(
      c,
      'documents.link-open',
      await deps.documents.openLinked({
        documentId: params.documentId,
        revision: params.revision,
        linkId: params.linkId,
        href: link.href,
        confirmation: params.confirmation,
      }),
    );
  });

  // SSE read via fetch (spec 6.5). Only IDs and revisions are streamed, never the body.
  // The `no-cache` set by streamSSE allows storing, so use `no-store` instead. With a storable response, Firefox
  // holds a second connection to the same URL (another screen or a reconnect) for about 20 seconds until the first response ends.
  api.get('/events', (c) => {
    const response = streamSSE(c, async (stream) => {
      let closed = false;
      let wake: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const finish = () => {
        closed = true;
        wake();
      };
      const token = c.get('token');
      // Writes are performed in order, and before ending the stream, wait for the requested writes to finish.
      // Closing without waiting loses the notifications emitted just before stopping.
      const queue = createEventQueue({
        writeEvent: (event) =>
          stream.writeSSE({
            event: event.type,
            id: String(event.sequence),
            data: JSON.stringify(event),
          }),
        writeHeartbeat: () => stream.write(': heartbeat\n\n'),
        // Check right before writing. Stop sending to an expired session without waiting for the next check.
        // A session that expired while waiting its turn is also stopped here.
        beforeWrite: () => {
          if (deps.sessions.isActive(token)) return true;
          drop();
          return false;
        },
        onError: finish,
      });
      // Stop sending and cut the connection (session expired or revoked, or writes stalled). Skip the remaining writes,
      // end the stalled write, and close the socket too (do not leave data queued for a peer that does not read).
      const drop = () => {
        queue.stop();
        finish();
        stream.abort();
        c.env.outgoing?.destroy();
      };
      streams.set(finish, queue);
      stream.onAbort(finish);
      // When the session is revoked, close the connection left open too. Do not keep streaming to an expired session.
      const stopWatchingSession = deps.sessions.onRevoke(token, drop);
      const send = (event: ServerEvent) => {
        if (!closed) queue.send(event);
      };
      // Announce the current sequence number on every connect. The receiver resyncs state from here.
      send({
        type: 'hello',
        daemonId: deps.daemonId,
        sequence: deps.events.sequence,
        catalogVersion: deps.documents.state.catalogVersion,
      });
      const unsubscribe = deps.events.subscribe(send);
      const heartbeat = setInterval(() => {
        // Keeping the connection open does not extend the session. Close once it expires.
        if (!deps.sessions.isActive(token)) {
          drop();
          return;
        }
        // Cut a connection whose receiver does not read and whose writes make no progress. The receiver reconnects and resyncs state.
        if (queue.stalledFor() >= (deps.stallMs ?? LIMITS.sseStallMs)) {
          drop();
          return;
        }
        queue.heartbeat();
      }, deps.heartbeatMs ?? LIMITS.sseHeartbeatMs);
      try {
        await done;
      } finally {
        clearInterval(heartbeat);
        stopWatchingSession();
        unsubscribe();
        await queue.settled();
        // Count it as a connection until the writes finish (do not hide unfinished connections from diagnostics).
        streams.delete(finish);
      }
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });

  api.all('*', (c) => fail(c, new VdeError('E_UNKNOWN_METHOD', 'Unknown API.')));
  api.onError((error, c) => fail(c, error));
  app.route(API_PREFIX, api);

  // Do not answer unknown paths under `/_/` with the UI's HTML.
  app.all('/_/*', (c) => fail(c, new VdeError('E_UNKNOWN_METHOD', 'Unknown API.')));

  app.on(['GET', 'HEAD'], '*', (c) => {
    const asset = assets.get(c.req.path);
    if (!asset) {
      if (assets.size === 0 && c.req.path === '/') {
        return c.text('The UI has not been built. Run pnpm build.', 503);
      }
      return c.text('Not Found', 404);
    }
    const headers: Record<string, string> = { 'Content-Type': asset.type };
    if (asset.immutable) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    if (asset.type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = uiCsp(deps.previewOrigin);
    }
    if (c.req.method === 'HEAD') return c.body(null, 200, headers);
    return c.body(new Uint8Array(asset.body), 200, headers);
  });

  app.all('*', (c) => c.text('Method Not Allowed', 405));
  app.onError((error, c) => fail(c, error));

  const server = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: options.port ?? 0,
  }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${String(port)}`;
  origin = `http://${host}`;

  return {
    port,
    origin,
    eventStreams() {
      let maxPending = 0;
      for (const queue of streams.values()) maxPending = Math.max(maxPending, queue.pending);
      return { streams: streams.size, maxPending };
    },
    async close() {
      // End the notification streams first. Close connections after the last notification (daemon-stopping) is delivered.
      for (const finish of streams.keys()) finish();
      await new Promise((resolve) => setTimeout(resolve, STREAM_FLUSH_MS));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        // Connections whose responses do not finish are cut after a short wait.
        setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS).unref();
      });
    },
  };
}
