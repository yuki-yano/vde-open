import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { serve, type HttpBindings } from '@hono/node-server';
import {
  errorEnvelope,
  isVdeError,
  LIMITS,
  mobileCheckParamsSchema,
  mobileGrantParamsSchema,
  mobileLinkParamsSchema,
  mobileReleaseParamsSchema,
  revisionSchema,
  successEnvelope,
  VdeError,
  viewEpochSchema,
  type DocumentSummary,
  type MobileContentResult,
  type MobileDocument,
  type MobileEvent,
  type MobileLinkResult,
  type MobileListResult,
  type ServerEvent,
} from '@vde-open/shared';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z, ZodError } from 'zod';

import type { MobileSettings } from '../../daemon/listener-config.ts';
import type { CursorCodec } from '../../documents/cursor.ts';
import type { DocumentService } from '../../documents/service.ts';
import type { RenderService } from '../../render/render-service.ts';
import type { ViewEpochs } from '../../render/view-epochs.ts';
import type { EventHub } from '../event-hub.ts';
import { createEventStreams } from './event-stream.ts';
import { loadStaticAssets } from './management.ts';

// The phone reader (ADR-0017). Reached only through Tailscale Serve, which adds the person's login.
const API_PREFIX = '/_/mobile/v1';
const STREAM_FLUSH_MS = 100;
const CLOSE_GRACE_MS = 1000;
const IDENTITY_HEADER = 'tailscale-user-login';

type DistinctHeaders = {
  headersDistinct: IncomingHttpHeaders | Record<string, string[] | undefined>;
};

// Exactly one header of that name, equal to the value. Node keeps only the first Host and joins other repeats,
// so an ambiguous request could otherwise pass on its first value.
export function hasExactlyOne(request: DistinctHeaders, name: string, value: string): boolean {
  const values = (request.headersDistinct as Record<string, string[] | undefined>)[name];
  return values?.length === 1 && values[0] === value;
}

// The only person allowed in: exactly one Tailscale-User-Login equal to the configured login.
// A missing header (not through Serve, or a tagged device), another login, or several values are refused.
export function isConfiguredPerson(request: DistinctHeaders, login: string): boolean {
  return hasExactlyOne(request, IDENTITY_HEADER, login);
}

// The body of a state change: exactly the JSON media type, whatever the transfer encoding, and valid JSON.
async function jsonBody(c: Context): Promise<unknown> {
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new VdeError('E_INVALID_ARGUMENT', 'JSON only.');
  try {
    return await c.req.json();
  } catch {
    throw new VdeError('E_INVALID_ARGUMENT', 'Invalid JSON.');
  }
}

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

export interface MobileDeps {
  daemonId: string;
  settings: MobileSettings;
  documents: DocumentService;
  events: EventHub;
  render: RenderService;
  views: ViewEpochs;
  cursors: CursorCodec;
  webRoot: string | null;
  isStopping: () => boolean;
  // Until this is true nothing is served (both phone listeners open together or not at all).
  isOpen: () => boolean;
  onEvent?: (event: string, fields: Record<string, string | number>) => void;
  heartbeatMs?: number;
  stallMs?: number;
}

export interface MobileServer {
  readonly port: number;
  eventStreams(): { streams: number; maxPending: number };
  close(): Promise<void>;
}

interface HttpEnv {
  Bindings: Partial<HttpBindings>;
}

// The phone gets fixed messages and no details: PC error bodies can carry paths.
const ERRORS: Record<string, { status: ContentfulStatusCode; message: string }> = {
  E_UNAUTHORIZED: { status: 403, message: 'This request is not allowed.' },
  E_DOCUMENT_NOT_FOUND: { status: 404, message: 'The document is not open.' },
  E_DOCUMENT_NOT_OPEN: { status: 404, message: 'The document is not open.' },
  E_UNKNOWN_METHOD: { status: 404, message: 'Unknown API.' },
  E_VIEW_STALE: { status: 409, message: 'The document changed. Fetch the list again.' },
  E_CURSOR_STALE: { status: 409, message: 'The list changed. Fetch it again from the start.' },
  E_INVALID_CURSOR: { status: 409, message: 'The cursor expired. Fetch again from the start.' },
  E_REVISION_UNAVAILABLE: { status: 409, message: 'The document changed. Fetch the list again.' },
  E_INVALID_ARGUMENT: { status: 400, message: 'The request is invalid.' },
  E_UNSUPPORTED_FORMAT: { status: 400, message: 'This document has no text to read here.' },
  E_DAEMON_STOPPING: { status: 503, message: 'The daemon is stopping.' },
};

function fail(c: Context, error: unknown) {
  const code = isVdeError(error)
    ? error.code
    : error instanceof ZodError
      ? 'E_INVALID_ARGUMENT'
      : 'E_INTERNAL';
  const known = ERRORS[code];
  return c.json(
    errorEnvelope({
      code: known ? code : 'E_INTERNAL',
      message: known?.message ?? 'An internal error occurred.',
      retryable: false,
      details: {},
    }),
    known?.status ?? 500,
  );
}

const limitQuery = z.coerce.number().int().min(1).max(LIMITS.listLimitMax);

export async function startMobileServer(
  deps: MobileDeps,
  options: { port: number },
): Promise<MobileServer> {
  const assets = await loadStaticAssets(deps.webRoot);
  const { settings, documents, render, views, cursors } = deps;
  const host = `${settings.host}:${String(settings.uiPort)}`;
  const origin = `https://${host}`;
  const previewOrigin = `https://${settings.host}:${String(settings.previewPort)}`;
  const streams = createEventStreams();
  const app = new Hono<HttpEnv>();

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  // Every route, asset, stream, and HEAD: the configured Host and the configured person, through Serve only.
  app.use('*', async (c, next) => {
    if (!deps.isOpen()) return fail(c, new VdeError('E_DAEMON_STOPPING', 'Not ready.'));
    const incoming = c.env.incoming as IncomingMessage | undefined;
    if (!incoming || !hasExactlyOne(incoming, 'host', host)) {
      deps.onEvent?.('mobile.rejected', { reason: 'host' });
      return fail(c, new VdeError('E_UNAUTHORIZED', 'Host.'));
    }
    if (!isConfiguredPerson(incoming, settings.login)) {
      deps.onEvent?.('mobile.rejected', { reason: 'identity' });
      return fail(c, new VdeError('E_UNAUTHORIZED', 'Identity.'));
    }
    return next();
  });

  // The API is for this UI only: same-origin fetches, and state changes only with Origin (bodies: jsonBody).
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    const requestOrigin = c.req.header('origin');
    if (requestOrigin !== undefined && requestOrigin !== origin) {
      deps.onEvent?.('mobile.rejected', { reason: 'origin' });
      return fail(c, new VdeError('E_UNAUTHORIZED', 'Origin.'));
    }
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin') {
      deps.onEvent?.('mobile.rejected', { reason: 'fetch-site' });
      return fail(c, new VdeError('E_UNAUTHORIZED', 'Fetch site.'));
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (requestOrigin === undefined) return fail(c, new VdeError('E_UNAUTHORIZED', 'Origin.'));
    }
    if (deps.isStopping()) return fail(c, new VdeError('E_DAEMON_STOPPING', 'Stopping.'));
    return next();
  });

  const rowOf = (summary: DocumentSummary): MobileDocument => ({
    documentId: summary.documentId,
    title: summary.title,
    format: summary.format,
    openedAt: summary.openedAt,
    revision: summary.revision,
    sourceState: summary.sourceState,
    effectiveMode:
      summary.format === 'html' ? (summary.interactiveAllowed ? 'interactive' : 'static') : null,
    viewEpoch: views.of(summary.documentId),
  });

  // The open document as the phone listed it. A different revision or view generation means the list is stale.
  const requireCurrent = (documentId: string, revision: unknown, viewEpoch: unknown) => {
    const record = documents.state.documents[documentId];
    if (!record?.isOpen) throw new VdeError('E_DOCUMENT_NOT_OPEN', 'Not open.');
    if (record.currentRevision !== revision || views.of(documentId) !== viewEpoch) {
      throw new VdeError('E_VIEW_STALE', 'Stale.');
    }
    return record;
  };

  const api = new Hono<HttpEnv>();

  // One page of the open documents. Continue with the cursor only; a cursor of the PC list is not accepted.
  api.get('/documents', (c) => {
    const cursor = c.req.query('cursor');
    const limit = c.req.query('limit');
    let inner: string | undefined;
    if (cursor !== undefined) {
      const payload = cursors.decode(cursor, 'mobile-list');
      if (payload['catalogVersion'] !== documents.state.catalogVersion) {
        throw new VdeError('E_CURSOR_STALE', 'Stale.');
      }
      inner = payload['inner'] as string;
    }
    const result = documents.list({
      limit: limit === undefined ? LIMITS.listLimitMax : limitQuery.parse(limit),
      ...(inner === undefined ? {} : { cursor: inner }),
    });
    const data: MobileListResult = {
      daemonId: deps.daemonId,
      catalogVersion: result.catalogVersion,
      documents: result.data.documents.map(rowOf),
      nextCursor:
        result.data.nextCursor === null
          ? null
          : cursors.encode({
              op: 'mobile-list',
              inner: result.data.nextCursor,
              catalogVersion: result.catalogVersion,
            }),
    };
    return c.json(
      successEnvelope(data, { command: 'mobile.documents', catalogVersion: result.catalogVersion }),
    );
  });

  // The Markdown source of the listed revision. The first page names the revision and view generation; each
  // continuation is bound to them and fails with 409 once either moves.
  api.get('/documents/:id/content', async (c) => {
    const documentId = c.req.param('id');
    const cursor = c.req.query('cursor');
    let bound: { revision: string; viewEpoch: string; inner: string | undefined };
    if (cursor === undefined) {
      bound = {
        revision: revisionSchema.parse(c.req.query('revision')),
        viewEpoch: viewEpochSchema.parse(c.req.query('viewEpoch')),
        inner: undefined,
      };
    } else {
      const payload = cursors.decode(cursor, 'mobile-read');
      if (payload['documentId'] !== documentId) throw new VdeError('E_INVALID_CURSOR', 'Other.');
      bound = {
        revision: payload['revision'] as string,
        viewEpoch: payload['viewEpoch'] as string,
        inner: payload['inner'] as string,
      };
    }
    const record = requireCurrent(documentId, bound.revision, bound.viewEpoch);
    if (record.format !== 'markdown') throw new VdeError('E_UNSUPPORTED_FORMAT', 'Format.');
    const read = await documents.read(
      bound.inner === undefined
        ? { documentId, revision: bound.revision, maxBytes: LIMITS.readMaxBytesMax }
        : { documentId, cursor: bound.inner, maxBytes: LIMITS.readMaxBytesMax },
    );
    // The document may have changed while reading.
    requireCurrent(documentId, bound.revision, bound.viewEpoch);
    const data: MobileContentResult = {
      documentId,
      revision: read.data.revision,
      content: read.data.content ?? '',
      nextCursor:
        read.data.nextCursor === null
          ? null
          : cursors.encode({
              op: 'mobile-read',
              documentId,
              revision: bound.revision,
              viewEpoch: bound.viewEpoch,
              inner: read.data.nextCursor,
            }),
    };
    return c.json(
      successEnvelope(data, {
        command: 'mobile.content',
        catalogVersion: documents.state.catalogVersion,
      }),
    );
  });

  // A view of the listed revision in the mode the PC allows. The phone cannot choose the mode or a question.
  api.post('/documents/:id/render-grants', async (c) => {
    const expected = mobileGrantParamsSchema.parse(await jsonBody(c));
    const data = await render.createMobileGrant(c.req.param('id'), expected);
    return c.json(
      successEnvelope(data, {
        command: 'mobile.render-grant',
        catalogVersion: documents.state.catalogVersion,
      }),
    );
  });

  // Unknown, expired, or PC grants count as released, so a retry is safe.
  api.post('/render-grants/release', async (c) => {
    const { grants } = mobileReleaseParamsSchema.parse(await jsonBody(c));
    return c.json(
      successEnvelope(
        { released: render.releaseMobile(grants) },
        { command: 'mobile.render-release' },
      ),
    );
  });

  api.post('/render-grants/check', async (c) => {
    const { grant } = mobileCheckParamsSchema.parse(await jsonBody(c));
    return c.json(
      successEnvelope({ valid: render.checkMobile(grant) }, { command: 'mobile.render-check' }),
    );
  });

  // A link of the shown view, to a document that is already open. Nothing is opened or focused on the PC.
  api.post('/links/resolve', async (c) => {
    const { grant, linkId } = mobileLinkParamsSchema.parse(await jsonBody(c));
    if (!render.checkMobile(grant)) throw new VdeError('E_VIEW_STALE', 'Stale.');
    const found = render.mobileLinkOf(grant, linkId);
    const documentId =
      found?.link.kind === 'document'
        ? await documents.openDocumentOfLink(found.documentId, found.link.href)
        : null;
    // The view may have been revoked while resolving.
    if (!render.checkMobile(grant)) throw new VdeError('E_VIEW_STALE', 'Stale.');
    const data: MobileLinkResult =
      documentId === null || !documents.state.documents[documentId]?.isOpen
        ? { status: 'not-open' }
        : { status: 'open', documentId };
    return c.json(successEnvelope(data, { command: 'mobile.link-resolve' }));
  });

  // Changes to the open documents, their revisions, and permissions. The phone fetches the list again on each.
  const frameOf = (event: ServerEvent): { event: string; data: string } | null => {
    let type: MobileEvent['type'];
    switch (event.type) {
      case 'hello':
      case 'resync-required':
      case 'daemon-stopping':
        type = event.type;
        break;
      case 'catalog-changed':
      case 'document-changed':
      case 'document-status':
        type = 'changed';
        break;
      default:
        return null;
    }
    const data: MobileEvent = {
      type,
      daemonId: event.daemonId,
      ...(type === 'changed' && event.documentId !== undefined
        ? { documentId: event.documentId }
        : {}),
    };
    return { event: type, data: JSON.stringify(data) };
  };
  api.get('/events', (c) =>
    streams.open(c, {
      hello: {
        type: 'hello',
        daemonId: deps.daemonId,
        sequence: deps.events.sequence,
        catalogVersion: documents.state.catalogVersion,
      },
      subscribe: (listener) => deps.events.subscribe(listener),
      frame: frameOf,
      heartbeatMs: deps.heartbeatMs,
      stallMs: deps.stallMs,
    }),
  );

  api.all('*', (c) => fail(c, new VdeError('E_UNKNOWN_METHOD', 'Unknown.')));
  api.onError((error, c) => fail(c, error));
  app.route(API_PREFIX, api);
  app.all('/_/*', (c) => fail(c, new VdeError('E_UNKNOWN_METHOD', 'Unknown.')));

  // The phone screen: `/` is mobile.html, plus the bundled assets. The PC's index.html is never served here.
  app.on(['GET', 'HEAD'], '*', (c) => {
    const path = c.req.path;
    const asset =
      path === '/'
        ? assets.get('/mobile.html')
        : path.startsWith('/assets/')
          ? assets.get(path)
          : undefined;
    if (!asset) {
      if (path === '/')
        return c.text('The phone reader UI has not been built. Run pnpm build.', 503);
      return c.text('Not Found', 404);
    }
    const headers: Record<string, string> = { 'Content-Type': asset.type };
    if (asset.immutable) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    if (asset.type.startsWith('text/html'))
      headers['Content-Security-Policy'] = uiCsp(previewOrigin);
    if (c.req.method === 'HEAD') return c.body(null, 200, headers);
    return c.body(new Uint8Array(asset.body), 200, headers);
  });
  app.all('*', (c) => c.text('Method Not Allowed', 405));
  app.onError((error, c) => fail(c, error));

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;

  return {
    port,
    eventStreams: () => streams.stats(),
    async close() {
      streams.finishAll();
      await new Promise((resolve) => setTimeout(resolve, STREAM_FLUSH_MS));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS).unref();
      });
    },
  };
}
