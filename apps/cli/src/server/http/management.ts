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

// 管理UIのpolicy（仕様10.5）。scriptは同梱のものだけ。APIへの接続は自分のoriginだけ。
// 文書の表示（iframe）と、文書中の登録済みの画像だけ、表示用のlistenerから読み込める。
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
  // 文書を表示するlistenerのorigin。
  previewOrigin: string;
  // ビルド済みUIのdirectory。無ければUIは配信しない。
  webRoot: string | null;
  // 開発時だけ許可するUIのorigin。配布物では常にnull。
  devOrigin: string | null;
  isStopping: () => boolean;
  onEvent?: (event: string, fields: Record<string, string | number>) => void;
  // 通知の接続を確かめる間隔。指定がなければ15秒（仕様6.5）。
  heartbeatMs?: number;
  // 書き込みが進まない通知の接続を切るまでの時間。指定がなければ`LIMITS.sseStallMs`。
  stallMs?: number;
}

export interface ManagementServer {
  readonly port: number;
  readonly origin: string;
  // 通知の接続の数と、接続ごとの書き終わっていない通知の数の最大（診断用）。
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
  // 配信するfileを起動時に確定する。requestのpathをfilesystemへ解決することはしない。
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

// 回答案を含むbody。重複したkeyと`__proto__`を拒否するため、原文から読む（ADR-0011）。
function parseAnswersBody(text: string): unknown {
  try {
    return parseStrictJson(text);
  } catch (error) {
    if (!(error instanceof StrictJsonError)) throw error;
    throw new VdeError('E_INVALID_ARGUMENT', '回答案をJSONとして読めません。', {
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
      message: '引数が正しくありません。',
      retryable: false,
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  }
  // 想定外の例外は、内容を相手へ返さない。
  return {
    code: 'E_INTERNAL',
    message: '内部errorが発生しました。',
    retryable: false,
    details: {},
  };
}

// error codeからHTTP statusを決める（仕様12.2）。clientは本文のcodeで処理する。
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
  // 通知の接続ごとの、終える関数と書き終わっていない通知の数。
  const streams = new Map<() => void, { readonly pending: number }>();

  // すべての応答に付けるheader。
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  // Hostは実際のlisten先だけを受け付ける。別名で到達するrequest（DNS rebinding）を拒否する。
  app.use('*', async (c, next) => {
    if (c.req.header('host') !== host) {
      deps.onEvent?.('http.rejected', { reason: 'host' });
      return fail(c, new VdeError('E_UNAUTHORIZED', 'このHostからは利用できません。'));
    }
    return next();
  });

  app.use(`${API_PREFIX}/*`, async (c, next) => {
    const requestOrigin = c.req.header('origin');
    const allowed =
      requestOrigin === origin || (deps.devOrigin !== null && requestOrigin === deps.devOrigin);
    // Originがあるなら、このUIのoriginでなければ拒否する。`null`も管理の主体として扱わない。
    if (requestOrigin !== undefined && !allowed) {
      deps.onEvent?.('http.rejected', { reason: 'origin' });
      return fail(c, new VdeError('E_UNAUTHORIZED', 'このOriginからは利用できません。'));
    }
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && !(deps.devOrigin !== null && allowed)) {
      deps.onEvent?.('http.rejected', { reason: 'fetch-site' });
      return fail(c, new VdeError('E_UNAUTHORIZED', 'このrequestは受け付けられません。'));
    }
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') {
      // 状態を変えるrequestは、UIのfetchからのものに限る。formの送信では作れない条件にする。
      if (requestOrigin === undefined) {
        return fail(c, new VdeError('E_UNAUTHORIZED', 'Originのないrequestでは変更できません。'));
      }
      const contentLength = Number(c.req.header('content-length') ?? '0');
      if (
        contentLength > 0 &&
        !(c.req.header('content-type') ?? '').startsWith('application/json')
      ) {
        return fail(c, new VdeError('E_INVALID_ARGUMENT', 'bodyはJSONで送ってください。'));
      }
    }
    if (deps.isStopping()) {
      return fail(c, new VdeError('E_DAEMON_STOPPING', 'daemonは停止処理中です。'));
    }
    // 入口のticket交換だけは、sessionなしで受け付ける。
    if (c.req.path === `${API_PREFIX}/sessions/bootstrap` && method === 'POST') return next();
    const authorization = c.req.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (token === '' || !deps.sessions.authenticate(token)) {
      return fail(c, new VdeError('E_UNAUTHORIZED', '認証が必要です。CLIから開き直してください。'));
    }
    c.set('token', token);
    return next();
  });

  const api = new Hono<HttpEnv>();

  api.post('/sessions/bootstrap', async (c) => {
    const body = z.strictObject({ ticket: z.string().min(1).max(256) }).parse(await c.req.json());
    const token = deps.sessions.exchange(body.ticket);
    if (!token) {
      return fail(c, new VdeError('E_UNAUTHORIZED', 'このURLは使用済みか、期限が切れています。'));
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
      // 続きは、cursorだけで取得する（cursorは、発行したときの版と取得の種類に固定されている）。
      ...(cursor === undefined ? { outline: true } : { cursor }),
      ...(revision === undefined ? {} : { revision }),
      ...(maxBytes === undefined ? {} : { maxBytes: integerQuery.parse(maxBytes) }),
    });
    if (result.data.mode !== 'outline') {
      throw new VdeError('E_INVALID_CURSOR', 'cursorが見出しの一覧のものではありません。', {
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
      // UIからはIDでだけ閉じる。pathを受け取るAPIは置かない。
      await deps.documents.close({ cwd: '/', targets: [c.req.param('id')], all: false }),
    ),
  );

  api.post('/documents/:id/focus', async (c) =>
    ok(c, 'documents.focus', await deps.documents.focus({ documentId: c.req.param('id') })),
  );

  api.post('/documents/:id/refresh', async (c) =>
    ok(c, 'documents.refresh', await deps.documents.refresh({ documentId: c.req.param('id') })),
  );

  // 開いている文書の検索。指定できる項目は、CLIと同じ（仕様12.2）。
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

  // 質問の一覧。回答案は含めない。
  api.get('/feedback', (c) => {
    const status = c.req.query('status');
    return ok(c, 'feedback.list', deps.feedback.list(status === undefined ? {} : { status }));
  });

  // 管理UI向けの質問。質問定義と回答案、文書の現在の版を含む。
  api.get('/feedback/:id', (c) =>
    ok(c, 'feedback.get', deps.feedback.getForUi(requestIdSchema.parse(c.req.param('id')))),
  );

  // 回答案を置き換える。重複したkeyを見つけるため、bodyは原文から読む（仕様11.2）。
  api.put('/feedback/:id/draft', async (c) => {
    const requestId = requestIdSchema.parse(c.req.param('id'));
    const body = parseAnswersBody(await c.req.text());
    return ok(c, 'feedback.draft', await deps.feedback.updateDraft(requestId, body));
  });

  // 回答待ちの質問が固定した版と表示方法での、表示の権限（仕様12.2）。
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

  // HTMLのSDKからの操作（回答案の取得と置き換え）。管理UIが、表示のiframeから受け取って中継する。
  // 権限（表示）はbodyで受け取り、いまも有効で、このsessionのもので、質問が回答待ちかを毎回確かめる。
  const bridgeOf = (token: string, grant: unknown) => {
    const found =
      typeof grant === 'string' ? deps.render.bridgeOf(deps.sessions.idOf(token), grant) : null;
    if (!found) {
      throw new VdeError(
        'E_RENDER_GRANT_INVALID',
        '表示の権限が失効したため、HTMLからの回答案は受け付けません。',
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
    // 保存の順番を待つ間に、権限の返却・scriptの許可の取消・sessionの失効が起きうる。
    // 保存のtransactionの中でも、同じ質問への権限が有効かを確かめ直す。
    return ok(
      c,
      'render-grants.bridge-draft',
      await deps.feedback.updateDraft(requestId, draft, {
        authorize: () => {
          if (bridgeOf(token, grant).requestId !== requestId) {
            throw new VdeError('E_RENDER_GRANT_INVALID', '表示の権限が変わりました。');
          }
        },
      }),
    );
  });

  // 保存済みの回答案を、回答として確定する。回答そのものは受け取らない（仕様11.8）。
  api.post('/feedback/:id/submit', async (c) =>
    ok(
      c,
      'feedback.submit',
      await deps.feedback.submit(requestIdSchema.parse(c.req.param('id')), await c.req.json()),
    ),
  );

  // 管理UIで確認したうえで、質問を中止する。
  api.post('/feedback/:id/cancel', async (c) => {
    feedbackCancelParamsSchema.parse(await c.req.json());
    return ok(
      c,
      'feedback.cancel',
      await deps.feedback.cancel({ requestId: c.req.param('id') }, 'user'),
    );
  });

  // 文書の1つの版を表示するための、限定された権限を発行する。権限は発行したsessionに結び付く。
  api.post('/documents/:id/render-grants', async (c) => {
    const body = z
      .strictObject({ revision: z.string().optional(), mode: z.string().optional() })
      .parse(await c.req.json());
    // 状態を変えるrequestのOriginは、入口で管理UIのoriginだと確かめてある。
    // HTMLのSDKは、このoriginの親とだけ通信を始める。
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

  // 表示の中から読み込もうとした、登録されていないfile。権限はURLへ載せず、bodyで渡す。
  api.post('/render-grants/missing', async (c) => {
    const body = z.strictObject({ grant: z.string().min(1).max(128) }).parse(await c.req.json());
    const missing = deps.render.missingOf(deps.sessions.idOf(c.get('token')), body.grant);
    return c.json(successEnvelope({ missing }, { command: 'render-grants.missing' }));
  });

  // HTMLの表示方法を変える。scriptを動かす表示（interactive）にするには、確認が必要（仕様10.2）。
  api.post('/documents/:id/html-mode', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    return ok(
      c,
      'documents.html-mode',
      await deps.documents.setHtmlMode({ ...body, documentId: c.req.param('id') }),
    );
  });

  // 表示をやめた権限を回収する。自分のsessionが発行したものだけを回収できる。
  api.post('/render-grants/release', async (c) => {
    const body = z
      .strictObject({ grants: z.array(z.string().min(1).max(128)).max(256) })
      .parse(await c.req.json());
    const released = deps.render.release(deps.sessions.idOf(c.get('token')), body.grants);
    return c.json(successEnvelope({ released }, { command: 'render-grants.release' }));
  });

  // 文書中のlinkが指すlocalの文書を開く。行き先は、解析で取り出したlinkのIDで指定する。
  // pathをclientから直接受け取ることはしない（仕様12.2）。
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

  // fetchで読むSSE（仕様6.5）。IDと版だけを流し、本文は流さない。
  // streamSSEが付ける`no-cache`は保存を許すので、`no-store`にする。保存できる応答だと、Firefoxは
  // 同じURLへの2つ目の接続（別の画面や再接続）を、1つ目の応答が終わるまで約20秒待たせる。
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
      // 書き込みは順に行い、streamを終える前に、依頼済みの書き込みが終わるのを待つ。
      // 待たずに閉じると、停止の直前に出した通知が届かない。
      const queue = createEventQueue({
        writeEvent: (event) =>
          stream.writeSSE({
            event: event.type,
            id: String(event.sequence),
            data: JSON.stringify(event),
          }),
        writeHeartbeat: () => stream.write(': heartbeat\n\n'),
        // 書き込みの直前に確かめる。期限が切れたsessionへは、次の確認を待たずに送るのをやめる。
        // 順番を待っている間に失効した場合も、ここで止まる。
        beforeWrite: () => {
          if (deps.sessions.isActive(token)) return true;
          drop();
          return false;
        },
        onError: finish,
      });
      // 送るのをやめて接続を切る（sessionの失効・破棄、書き込みの詰まり）。残りの書き込みはせず、
      // 詰まった書き込みを終わらせてsocketも閉じる（読まない相手へ送る分を残さない）。
      const drop = () => {
        queue.stop();
        finish();
        stream.abort();
        c.env.outgoing?.destroy();
      };
      streams.set(finish, queue);
      stream.onAbort(finish);
      // sessionが破棄されたら、開いたままの接続も閉じる。失効したsessionへ通知を流し続けない。
      const stopWatchingSession = deps.sessions.onRevoke(token, drop);
      const send = (event: ServerEvent) => {
        if (!closed) queue.send(event);
      };
      // 接続のたびに現在の連番を知らせる。受け手はここからstateを取り直す。
      send({
        type: 'hello',
        daemonId: deps.daemonId,
        sequence: deps.events.sequence,
        catalogVersion: deps.documents.state.catalogVersion,
      });
      const unsubscribe = deps.events.subscribe(send);
      const heartbeat = setInterval(() => {
        // 接続を保っているだけでは、sessionの期限は延びない。期限が切れたら閉じる。
        if (!deps.sessions.isActive(token)) {
          drop();
          return;
        }
        // 受け手が読まず、書き込みが進まない接続は切る。受け手は接続し直して、stateを取り直す。
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
        // 書き込みを終えるまで、接続として数える（診断に、終わっていない接続を隠さない）。
        streams.delete(finish);
      }
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });

  api.all('*', (c) => fail(c, new VdeError('E_UNKNOWN_METHOD', '未知のAPIです。')));
  api.onError((error, c) => fail(c, error));
  app.route(API_PREFIX, api);

  // `/_/`配下の未知のpathを、UIのHTMLで応答しない。
  app.all('/_/*', (c) => fail(c, new VdeError('E_UNKNOWN_METHOD', '未知のAPIです。')));

  app.on(['GET', 'HEAD'], '*', (c) => {
    const asset = assets.get(c.req.path);
    if (!asset) {
      if (assets.size === 0 && c.req.path === '/') {
        return c.text('UIがビルドされていません。pnpm build を実行してください。', 503);
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
      // 通知のstreamを先に終える。最後の通知（daemon-stopping）が届いてから接続を閉じる。
      for (const finish of streams.keys()) finish();
      await new Promise((resolve) => setTimeout(resolve, STREAM_FLUSH_MS));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        // 応答が終わらない接続は、少し待ってから切る。
        setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS).unref();
      });
    },
  };
}
