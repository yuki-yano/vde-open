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
}

type SnapshotFile =
  // 変換後のHTMLと、参照を調べ直したCSSは、memoryから配信する。
  | { kind: 'inline'; body: Buffer; mime: string; role: 'document' | AssetRole }
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
  snapshot: Snapshot;
}

export interface RenderService {
  // 1つの文書の1つの版を表示するための、限定された権限を発行する（仕様10.2）。
  createGrant(sessionId: string, params: unknown): Promise<RenderGrantResult>;
  // 表示をやめたときに、権限を回収する。別のsessionの権限には触れない。
  release(sessionId: string, grants: string[]): number;
  // 表示用URLが指すfile。権限が無効、または登録されていないpathならnull。
  resolve(grant: string, logicalPath: string): Promise<PreviewFile | null>;
  // 表示している版の、文書中のlink。
  linkOf(documentId: string, revision: string, linkId: string): Promise<RenderLink>;
  // 閉じた文書の権限を失効させる。開き直しても、閉じる前の権限は戻らない。
  pruneClosed(): void;
  readonly grantCount: number;
}

export interface RenderServiceOptions {
  store: StateStore;
  documents: DocumentService;
  sessions: SessionService;
  parse: ParseService;
  previewOrigin: () => string;
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

  const snapshotOf = async (documentId: string, revision: string | undefined) => {
    const { record, entry } = documents.describeRevision(documentId, revision);
    // 版は本文とassetの内容で決まり、文書の位置を含まない。同じ内容の文書が別の位置にあれば、
    // 版は同じでも、配信するpathと相対参照の解決が変わる。
    const cacheKey = `${entry.revision}\n${entry.documentLogicalPath}`;
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
    const output: RenderOutput = await parse.render({
      format: entry.format,
      source,
      documentLogicalPath: entry.documentLogicalPath,
      assets: usable.map(({ logicalPath, role }) => ({ logicalPath, role })),
      stylesheets,
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
      files.set(entry.documentLogicalPath, {
        kind: 'inline',
        body: Buffer.from(output.html),
        mime: HTML_MIME,
        role: 'document',
      });
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
  const liveGrant = (key: string): Grant | null => {
    const grant = grants.get(key);
    if (!grant) return null;
    const record = documents.state.documents[grant.documentId];
    if (
      !sessions.isActiveId(grant.sessionId) ||
      !record?.isOpen ||
      documents.openEpoch(grant.documentId) !== grant.openEpoch
    ) {
      grants.delete(key);
      return null;
    }
    return grant;
  };

  return {
    get grantCount() {
      return grants.size;
    },

    async createGrant(sessionId, rawParams) {
      const params = renderGrantParamsSchema.parse(rawParams);
      // 変換を待つ間に文書が閉じられたら、閉じる前に始めた発行は成立させない。
      // 開き直されていれば、開いていることを確かめ直してから発行する。
      let openEpoch = documents.openEpoch(params.documentId);
      let prepared = await snapshotOf(params.documentId, params.revision);
      if (documents.openEpoch(params.documentId) !== openEpoch) {
        openEpoch = documents.openEpoch(params.documentId);
        prepared = await snapshotOf(params.documentId, params.revision);
        if (documents.openEpoch(params.documentId) !== openEpoch) {
          throw new VdeError('E_DOCUMENT_NOT_OPEN', '文書は開かれていません。', {
            documentId: params.documentId,
          });
        }
      }
      const { record, entry, snapshot } = prepared;
      // 256bitの乱数。この文書・この版の表示にだけ使え、管理APIには使えない。
      const key = randomBytes(32).toString('base64url');
      grants.set(key, {
        sessionId,
        documentId: record.documentId,
        openEpoch,
        revision: entry.revision,
        mode: params.mode,
        snapshot,
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
      // 登録したpathとの完全一致だけで引く。filesystemのpathへは解決しない。
      const file = grant?.snapshot.files.get(logicalPath);
      if (!grant || !file) return null;
      const body = file.kind === 'inline' ? file.body : await store.readBlob(file.sha256);
      // 内容を読んでいる間に失効していたら、配信しない。
      if (!liveGrant(key)) return null;
      return { body, mime: file.mime, role: file.role, grant: key };
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
