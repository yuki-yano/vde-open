import { randomBytes } from 'node:crypto';

import { encodeLogicalPath, type AssetRole } from '@vde-open/document';
import type { RenderOutput } from '@vde-open/document/render';
import {
  LIMITS,
  renderGrantParamsSchema,
  VdeError,
  type DocumentFormat,
  type HtmlMode,
  type RenderDiagnostic,
  type RenderGrantResult,
  type RenderLink,
} from '@vde-open/shared';

import type { DocumentService } from '../documents/service.ts';
import { bridgeSdkScript } from './bridge-sdk.ts';
import type { StateStore } from '../persistence/state-store.ts';
import type { SessionService } from '../server/session-service.ts';
import type { ParseService } from '../workers/parse-service.ts';

// 表示用URLで配信する1つのfile。roleは、応答のheaderを決める。
export interface PreviewFile {
  body: Buffer;
  mime: string;
  role: 'document' | AssetRole;
  // 表示用URLの、秘密を含む部分。応答のCSPで、この表示の中だけを許可するために使う。
  grant: string;
  // 文書の表示方法。interactiveの文書だけ、scriptの実行を許すCSPで配信する。
  mode: HtmlMode;
}

type SnapshotFile =
  // 変換後のHTMLと、参照を調べ直したCSSは、memoryから配信する。
  | { kind: 'inline'; body: Buffer; mime: string; role: 'document' | AssetRole }
  // SDKを入れたHTML。SDKの設定（表示ごとに違う）を、beforeとafterの間に入れて配信する。
  | { kind: 'bridged'; before: Buffer; after: Buffer; mime: string; role: 'document' }
  // それ以外は、登録時に保存した内容を配信する。
  | { kind: 'blob'; sha256: string; mime: string; role: AssetRole };

// 1つの版を表示するための内容。版が同じなら、内容も同じ。
interface Snapshot {
  format: DocumentFormat;
  documentLogicalPath: string;
  hasDocument: boolean;
  files: Map<string, SnapshotFile>;
  assets: Array<{ logicalPath: string; role: AssetRole }>;
  links: RenderLink[];
  diagnostics: RenderDiagnostic[];
}

interface Grant {
  sessionId: string;
  documentId: string;
  // 発行したときの、文書の閉じた回数。閉じた後は、開き直しても使えない。
  openEpoch: number;
  revision: string;
  mode: HtmlMode;
  // interactiveの表示を発行したときの、scriptの実行の許可の世代。許可が外れるか、許可し直したら使えない。
  permission: number | null;
  snapshot: Snapshot;
  // HTMLと本体の間の通信。SDKへ渡す設定（JSON）を持つ。
  bridge: { instanceId: string; requestId: string; config: Buffer } | null;
  // 表示の中から読み込もうとした、登録されていないfile。
  missing: Set<string>;
}

// 表示を発行したrequestの情報。
export interface GrantContext {
  // 管理UIのorigin。SDKは、このoriginの親とだけ通信を始める。
  origin: string;
}

export interface RenderService {
  // 1つの文書の1つの版を表示するための、限定された権限を発行する（仕様10.2）。
  createGrant(
    sessionId: string,
    params: unknown,
    context: GrantContext,
  ): Promise<RenderGrantResult>;
  // 回答待ちの質問が固定した版と表示方法で、表示の権限を発行する（仕様11.4、12.2）。
  // 表示方法は、質問を作ったときの表示方法と、いまのscriptの実行の許可から決める。
  // interactiveなら、その質問の回答案をHTMLから送れるよう、SDKを入れる。
  createGrantForRequest(
    sessionId: string,
    requestId: string,
    context: GrantContext,
  ): Promise<RenderGrantResult>;
  // SDKを入れた表示の権限が、いまも有効で、そのsessionのもので、質問が回答待ちなら、その質問。
  bridgeOf(
    sessionId: string,
    grant: string,
  ): { requestId: string; documentId: string; revision: string } | null;
  // 表示をやめたときに、権限を回収する。別のsessionの権限には触れない。
  release(sessionId: string, grants: string[]): number;
  // 表示用URLが指すfile。権限が無効、または登録されていないpathならnull。
  resolve(grant: string, logicalPath: string): Promise<PreviewFile | null>;
  // 表示している版の、文書中のlink。
  linkOf(documentId: string, revision: string, linkId: string): Promise<RenderLink>;
  // 閉じた文書の権限を失効させる。開き直しても、閉じる前の権限は戻らない。
  pruneClosed(): void;
  // 表示の中から読み込もうとした、登録されていないfile。自分のsessionの権限だけを調べられる。
  missingOf(sessionId: string, grant: string): string[];
  readonly grantCount: number;
}

export interface RenderServiceOptions {
  store: StateStore;
  documents: DocumentService;
  sessions: SessionService;
  parse: ParseService;
  previewOrigin: () => string;
  // 表示の中から、登録されていないfileを新しく読み込もうとしたとき（UIへ知らせる）。
  onMissing?: (documentId: string) => void;
}

const SNAPSHOT_CACHE_SIZE = 8;
const HTML_MIME = 'text/html; charset=utf-8';

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function createRenderService(options: RenderServiceOptions): RenderService {
  const { store, documents, sessions, parse } = options;
  const grants = new Map<string, Grant>();
  const snapshots = new Map<string, Snapshot>();

  // sessionが破棄されたら、そのsessionが持つ権限もすべて失効する。
  sessions.onAnyRevoke((sessionId) => {
    for (const [key, grant] of grants) if (grant.sessionId === sessionId) grants.delete(key);
  });

  const snapshotOf = async (
    documentId: string,
    revision: string | undefined,
    mode: HtmlMode = 'static',
    withSdk = false,
  ) => {
    const { record, entry } = documents.describeRevision(documentId, revision);
    // 版は本文とassetの内容で決まり、文書の位置を含まない。同じ内容の文書が別の位置にあれば、
    // 版は同じでも、配信するpathと相対参照の解決が変わる。表示方法とSDKの有無でも変わる。
    const cacheKey = `${entry.revision}\n${entry.documentLogicalPath}\n${mode}\n${String(withSdk)}`;
    const cached = snapshots.get(cacheKey);
    if (cached) {
      // 使ったものを末尾へ移し、古いものから捨てる。
      snapshots.delete(cacheKey);
      snapshots.set(cacheKey, cached);
      return { record, entry, snapshot: cached };
    }

    const source = (await store.readBlob(entry.sourceSha256)).toString('utf8');
    const stylesheets: Array<{ logicalPath: string; text: string }> = [];
    for (const asset of entry.assets) {
      if (asset.role !== 'style') continue;
      const text = decodeUtf8(await store.readBlob(asset.sha256));
      // UTF-8として読めないCSSは、参照を調べられないので配信しない。
      if (text !== null) stylesheets.push({ logicalPath: asset.logicalPath, text });
    }
    const readable = new Set(stylesheets.map((sheet) => sheet.logicalPath));
    const usable = entry.assets.filter(
      (asset) => asset.role !== 'style' || readable.has(asset.logicalPath),
    );
    // SDKの設定を入れる位置の目印。推測できない値なので、文書の中に同じ文字列は現れない。
    const slot = withSdk ? `__vde_bridge_config_${randomBytes(16).toString('hex')}__` : null;
    const output: RenderOutput = await parse.render({
      format: entry.format,
      source,
      documentLogicalPath: entry.documentLogicalPath,
      assets: usable.map(({ logicalPath, role }) => ({ logicalPath, role })),
      stylesheets,
      mode,
      sdkScript: slot === null ? null : bridgeSdkScript(slot),
    });

    const files = new Map<string, SnapshotFile>();
    const css = new Map(output.stylesheets.map((sheet) => [sheet.logicalPath, sheet.css]));
    for (const asset of usable) {
      const converted = css.get(asset.logicalPath);
      files.set(
        asset.logicalPath,
        converted === undefined
          ? { kind: 'blob', sha256: asset.sha256, mime: asset.mime, role: asset.role }
          : { kind: 'inline', body: Buffer.from(converted), mime: asset.mime, role: asset.role },
      );
    }
    if (output.html !== null) {
      const at = slot === null ? -1 : output.html.indexOf(slot);
      if (slot !== null && at === -1) throw new Error('SDKを入れられませんでした。');
      files.set(
        entry.documentLogicalPath,
        slot === null
          ? { kind: 'inline', body: Buffer.from(output.html), mime: HTML_MIME, role: 'document' }
          : {
              kind: 'bridged',
              before: Buffer.from(output.html.slice(0, at)),
              after: Buffer.from(output.html.slice(at + slot.length)),
              mime: HTML_MIME,
              role: 'document',
            },
      );
    }
    const snapshot: Snapshot = {
      format: entry.format,
      documentLogicalPath: entry.documentLogicalPath,
      hasDocument: output.html !== null,
      files,
      assets: usable.map(({ logicalPath, role }) => ({ logicalPath, role })),
      links: output.links,
      diagnostics: output.diagnostics,
    };
    snapshots.set(cacheKey, snapshot);
    while (snapshots.size > SNAPSHOT_CACHE_SIZE) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
    return { record, entry, snapshot };
  };

  // 権限が有効なのは、発行したsessionが有効で、文書が開いている間だけ。
  // interactiveの表示は、scriptの実行の許可が外れたら使えない。
  const liveGrant = (key: string): Grant | null => {
    const grant = grants.get(key);
    if (!grant) return null;
    const record = documents.state.documents[grant.documentId];
    if (
      !sessions.isActiveId(grant.sessionId) ||
      !record?.isOpen ||
      documents.openEpoch(grant.documentId) !== grant.openEpoch ||
      (grant.mode === 'interactive' &&
        documents.interactiveGeneration(grant.documentId) !== grant.permission)
    ) {
      grants.delete(key);
      return null;
    }
    return grant;
  };

  // 表示の権限を発行する。requestIdがあれば、その質問の回答案をHTMLから送れるよう、SDKを入れる。
  const issue = async (
    sessionId: string,
    params: {
      documentId: string;
      revision?: string | undefined;
      mode: HtmlMode;
      requestId: string | null;
    },
    context: GrantContext,
  ): Promise<RenderGrantResult> => {
    const interactive = params.mode === 'interactive';
    // scriptを動かす表示は、利用者が明示的に許可したHTMLの文書だけ（仕様10.2）。
    // 発行した表示は、そのときの許可（世代）に結び付ける。
    const permissionOf = (): number | null => {
      if (!interactive) return null;
      const generation = documents.interactiveGeneration(params.documentId);
      if (generation === null) {
        throw new VdeError(
          'E_INTERACTIVE_NOT_ALLOWED',
          'この文書では、scriptを動かす表示（interactive）が許可されていません。',
          { documentId: params.documentId },
        );
      }
      return generation;
    };
    permissionOf();
    // 変換を待つ間に文書が閉じられたら、閉じる前に始めた発行は成立させない。
    // 開き直されていれば、開いていることを確かめ直してから発行する。
    const withSdk = params.requestId !== null;
    let openEpoch = documents.openEpoch(params.documentId);
    let prepared = await snapshotOf(params.documentId, params.revision, params.mode, withSdk);
    if (documents.openEpoch(params.documentId) !== openEpoch) {
      openEpoch = documents.openEpoch(params.documentId);
      prepared = await snapshotOf(params.documentId, params.revision, params.mode, withSdk);
      if (documents.openEpoch(params.documentId) !== openEpoch) {
        throw new VdeError('E_DOCUMENT_NOT_OPEN', '文書は開かれていません。', {
          documentId: params.documentId,
        });
      }
    }
    // 変換を待つ間に許可が外れていれば、発行しない。
    const permission = permissionOf();
    const { record, entry, snapshot } = prepared;
    // 変換を待つ間に質問が終わっていれば（中止・確定・削除）、SDKを入れた表示を発行しない（仕様11.6）。
    if (params.requestId !== null) {
      const request = Object.hasOwn(store.payload.feedbackRequests, params.requestId)
        ? store.payload.feedbackRequests[params.requestId]
        : undefined;
      if (!request) {
        throw new VdeError('E_REQUEST_NOT_FOUND', '質問が見つかりません。', {
          requestId: params.requestId,
        });
      }
      if (request.status !== 'pending') {
        throw new VdeError('E_REQUEST_NOT_PENDING', '質問は回答待ちではありません。', {
          requestId: params.requestId,
          status: request.status,
        });
      }
      if (
        request.documentId !== record.documentId ||
        request.revision !== entry.revision ||
        request.renderMode !== 'interactive'
      ) {
        throw new VdeError(
          'E_INVALID_ARGUMENT',
          'この表示では、その質問の回答案をHTMLから送れません。',
          {
            requestId: params.requestId,
          },
        );
      }
    }
    if (interactive && snapshot.format !== 'html') {
      throw new VdeError('E_INVALID_ARGUMENT', 'interactiveはHTMLの文書だけで使えます。');
    }
    let bridge: Grant['bridge'] = null;
    if (params.requestId !== null) {
      const instanceId = randomBytes(16).toString('base64url');
      bridge = {
        instanceId,
        requestId: params.requestId,
        config: Buffer.from(JSON.stringify({ instanceId, parentOrigin: context.origin })),
      };
    }
    // 256bitの乱数。この文書・この版の表示にだけ使え、管理APIには使えない。
    const key = randomBytes(32).toString('base64url');
    grants.set(key, {
      sessionId,
      documentId: record.documentId,
      openEpoch,
      revision: entry.revision,
      mode: params.mode,
      permission,
      snapshot,
      bridge,
      missing: new Set(),
    });
    // 1つのsessionが持てる数を限る。超えた分は、古いものから失効させる。
    const owned = [...grants].filter(([, grant]) => grant.sessionId === sessionId);
    for (const [oldKey] of owned.slice(
      0,
      Math.max(0, owned.length - LIMITS.renderGrantsPerSession),
    )) {
      grants.delete(oldKey);
    }
    const filesBaseUrl = `${options.previewOrigin()}/r/${key}/files/`;
    return {
      grant: key,
      documentId: record.documentId,
      revision: entry.revision,
      format: snapshot.format,
      mode: params.mode,
      documentUrl: snapshot.hasDocument
        ? `${filesBaseUrl}${encodeLogicalPath(snapshot.documentLogicalPath)}`
        : null,
      filesBaseUrl,
      documentLogicalPath: snapshot.documentLogicalPath,
      assets: snapshot.assets,
      links: snapshot.links,
      diagnostics:
        entry.assetScan === 'failed'
          ? [{ code: 'asset-scan-failed', target: null, count: 1 }, ...snapshot.diagnostics]
          : snapshot.diagnostics,
      bridge:
        bridge === null ? null : { instanceId: bridge.instanceId, requestId: bridge.requestId },
    };
  };

  return {
    get grantCount() {
      return grants.size;
    },

    async createGrant(sessionId, rawParams, context) {
      const params = renderGrantParamsSchema.parse(rawParams);
      return issue(sessionId, { ...params, requestId: null }, context);
    },

    async createGrantForRequest(sessionId, requestId, context) {
      const request = Object.hasOwn(store.payload.feedbackRequests, requestId)
        ? store.payload.feedbackRequests[requestId]
        : undefined;
      if (!request) {
        throw new VdeError('E_REQUEST_NOT_FOUND', '質問が見つかりません。', { requestId });
      }
      if (request.status !== 'pending') {
        throw new VdeError('E_REQUEST_NOT_PENDING', '質問は回答待ちではありません。', {
          requestId,
          status: request.status,
        });
      }
      // staticで作った質問は、後から文書のscriptを許可しても、interactiveにしない。
      // interactiveで作った質問も、scriptの実行の許可が外れていれば、静的表示にする。
      const interactive =
        request.renderMode === 'interactive' && documents.interactiveAllowed(request.documentId);
      return issue(
        sessionId,
        {
          documentId: request.documentId,
          revision: request.revision,
          mode: interactive ? 'interactive' : 'static',
          requestId: interactive ? request.requestId : null,
        },
        context,
      );
    },

    bridgeOf(sessionId, key) {
      const grant = liveGrant(key);
      if (!grant?.bridge || grant.sessionId !== sessionId) return null;
      const request = store.payload.feedbackRequests[grant.bridge.requestId];
      if (request?.status !== 'pending') return null;
      return {
        requestId: grant.bridge.requestId,
        documentId: grant.documentId,
        revision: grant.revision,
      };
    },

    release(sessionId, keys) {
      let released = 0;
      for (const key of keys) {
        if (grants.get(key)?.sessionId === sessionId && grants.delete(key)) released += 1;
      }
      return released;
    },

    async resolve(key, logicalPath) {
      const grant = liveGrant(key);
      if (!grant) return null;
      // 登録したpathとの完全一致だけで引く。filesystemのpathへは解決しない。
      const file = grant.snapshot.files.get(logicalPath);
      if (!file) {
        // 登録されていないfileの読み込みを記録し、UIで登録の方法を示せるようにする（仕様10.3）。
        if (!grant.missing.has(logicalPath) && grant.missing.size < LIMITS.renderMissingPerGrant) {
          grant.missing.add(logicalPath);
          options.onMissing?.(grant.documentId);
        }
        return null;
      }
      const body =
        file.kind === 'inline'
          ? file.body
          : file.kind === 'bridged'
            ? Buffer.concat([file.before, grant.bridge?.config ?? Buffer.from('null'), file.after])
            : await store.readBlob(file.sha256);
      // 内容を読んでいる間に失効していたら、配信しない。
      if (!liveGrant(key)) return null;
      return { body, mime: file.mime, role: file.role, grant: key, mode: grant.mode };
    },

    missingOf(sessionId, key) {
      const grant = liveGrant(key);
      if (!grant || grant.sessionId !== sessionId) return [];
      return [...grant.missing];
    },

    pruneClosed() {
      for (const [key, grant] of grants) {
        if (!documents.state.documents[grant.documentId]?.isOpen) grants.delete(key);
      }
    },

    async linkOf(documentId, revision, linkId) {
      const { snapshot } = await snapshotOf(documentId, revision);
      const link = snapshot.links.find((candidate) => candidate.linkId === linkId);
      if (!link) {
        throw new VdeError('E_LINK_NOT_FOUND', 'linkが見つかりません。', { documentId, linkId });
      }
      return link;
    },
  };
}
