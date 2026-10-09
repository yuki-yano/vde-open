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
import type { ParseService } from '../workers/parse-service.ts';

// One file served from a preview URL. role determines the response headers.
export interface PreviewFile {
  body: Buffer;
  mime: string;
  role: 'document' | AssetRole;
  // The secret part of the preview URL. Used in the response CSP to allow only this view.
  grant: string;
  // The document's view mode. Only interactive documents are served with a CSP that allows scripts.
  mode: HtmlMode;
}

type SnapshotFile =
  // Rendered HTML and CSS with rewritten references are served from memory.
  | { kind: 'inline'; body: Buffer; mime: string; role: 'document' | AssetRole }
  // HTML with the SDK. Served with the SDK config (different per view) inserted between before and after.
  | { kind: 'bridged'; before: Buffer; after: Buffer; mime: string; role: 'document' }
  // Everything else is served from the content saved at registration.
  | { kind: 'blob'; sha256: string; mime: string; role: AssetRole };

// Content for viewing one revision. The same revision yields the same content.
interface Snapshot {
  format: DocumentFormat;
  documentLogicalPath: string;
  hasDocument: boolean;
  files: Map<string, SnapshotFile>;
  assets: Array<{ logicalPath: string; role: AssetRole }>;
  links: RenderLink[];
  diagnostics: RenderDiagnostic[];
  headingTargets: RenderGrantResult['headingTargets'];
}

interface Grant {
  documentId: string;
  // The document's close count at issue time. Unusable after a close, even if reopened.
  openEpoch: number;
  revision: string;
  mode: HtmlMode;
  // Script permission generation when the interactive view was issued. Unusable once the permission is revoked or re-granted.
  permission: number | null;
  snapshot: Snapshot;
  // Communication between the HTML and the host. Holds the config (JSON) passed to the SDK.
  bridge: { instanceId: string; requestId: string; config: Buffer } | null;
  // Unregistered files the view tried to load.
  missing: Set<string>;
}

// Information about the request that issued the view.
export interface GrantContext {
  // Origin of the management UI. The SDK only starts communication with a parent of this origin.
  origin: string;
}

export interface RenderService {
  // Issues a limited grant to view one revision of one document (spec 10.2).
  createGrant(params: unknown, context: GrantContext): Promise<RenderGrantResult>;
  // Issues a render grant for the revision and view mode pinned by a pending question (spec 11.4, 12.2).
  // The view mode is decided from the mode when the question was created and the current script permission.
  // If interactive, the SDK is included so the HTML can send draft answers for that question.
  createGrantForRequest(requestId: string, context: GrantContext): Promise<RenderGrantResult>;
  // The question, if the SDK-enabled render grant is still valid and the question is pending.
  bridgeOf(grant: string): { requestId: string; documentId: string; revision: string } | null;
  // Reclaims the specified grants when their views are closed.
  release(grants: string[]): number;
  // The file a preview URL points to. null if the grant is invalid or the path is not registered.
  resolve(grant: string, logicalPath: string): Promise<PreviewFile | null>;
  // A link in the document, for the displayed revision.
  linkOf(documentId: string, revision: string, linkId: string): Promise<RenderLink>;
  // Revokes grants of closed documents. Grants from before a close do not come back on reopen.
  pruneClosed(): void;
  // Unregistered files the specified view tried to load.
  missingOf(grant: string): string[];
  readonly grantCount: number;
  // Counts of retained entries (used to check for resource leaks; daemon.diagnostics).
  retainedCounts(): Record<string, number>;
}

export interface RenderServiceOptions {
  store: StateStore;
  documents: DocumentService;
  parse: ParseService;
  previewOrigin: () => string;
  // Called when the view tries to load a new unregistered file (to notify the UI).
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
  const { store, documents, parse } = options;
  const grants = new Map<string, Grant>();
  const snapshots = new Map<string, Snapshot>();

  const snapshotOf = async (
    documentId: string,
    revision: string | undefined,
    mode: HtmlMode = 'static',
    withSdk = false,
  ) => {
    const { record, entry } = documents.describeRevision(documentId, revision);
    // The revision depends on the content and assets, not the document location. The same content at another location
    // has the same revision but different served paths and relative reference resolution. The view mode and SDK presence also matter.
    const cacheKey = `${entry.revision}\n${entry.documentLogicalPath}\n${mode}\n${String(withSdk)}`;
    const cached = snapshots.get(cacheKey);
    if (cached) {
      // Move the used entry to the end; the oldest is evicted first.
      snapshots.delete(cacheKey);
      snapshots.set(cacheKey, cached);
      return { record, entry, snapshot: cached };
    }

    const source = (await store.readBlob(entry.sourceSha256)).toString('utf8');
    const stylesheets: Array<{ logicalPath: string; text: string }> = [];
    for (const asset of entry.assets) {
      if (asset.role !== 'style') continue;
      const text = decodeUtf8(await store.readBlob(asset.sha256));
      // CSS that is not valid UTF-8 cannot be scanned for references, so it is not served.
      if (text !== null) stylesheets.push({ logicalPath: asset.logicalPath, text });
    }
    const readable = new Set(stylesheets.map((sheet) => sheet.logicalPath));
    const usable = entry.assets.filter(
      (asset) => asset.role !== 'style' || readable.has(asset.logicalPath),
    );
    // Marker for where the SDK config goes. Unguessable, so the same string never appears in the document.
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
      if (slot !== null && at === -1) throw new Error('The SDK could not be inserted.');
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
      headingTargets: output.headingTargets,
    };
    snapshots.set(cacheKey, snapshot);
    while (snapshots.size > SNAPSHOT_CACHE_SIZE) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
    return { record, entry, snapshot };
  };

  // A grant is valid only while the document is open.
  // An interactive view is unusable once the script permission is revoked.
  const liveGrant = (key: string): Grant | null => {
    const grant = grants.get(key);
    if (!grant) return null;
    const record = documents.state.documents[grant.documentId];
    if (
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

  // Issues a render grant. With a requestId, the SDK is included so the HTML can send draft answers for that question.
  const issue = async (
    params: {
      documentId: string;
      revision?: string | undefined;
      mode: HtmlMode;
      requestId: string | null;
    },
    context: GrantContext,
  ): Promise<RenderGrantResult> => {
    const interactive = params.mode === 'interactive';
    // The interactive view is only for HTML documents the user explicitly allowed (spec 10.2).
    // The issued view is bound to the permission (generation) at that time.
    const permissionOf = (): number | null => {
      if (!interactive) return null;
      const generation = documents.interactiveGeneration(params.documentId);
      if (generation === null) {
        throw new VdeError(
          'E_INTERACTIVE_NOT_ALLOWED',
          'The interactive view is not allowed for this document.',
          { documentId: params.documentId },
        );
      }
      return generation;
    };
    permissionOf();
    // If the document is closed while rendering, an issue started before the close must not succeed.
    // If it was reopened, re-check that it is open before issuing.
    const withSdk = params.requestId !== null;
    let openEpoch = documents.openEpoch(params.documentId);
    let prepared = await snapshotOf(params.documentId, params.revision, params.mode, withSdk);
    if (documents.openEpoch(params.documentId) !== openEpoch) {
      openEpoch = documents.openEpoch(params.documentId);
      prepared = await snapshotOf(params.documentId, params.revision, params.mode, withSdk);
      if (documents.openEpoch(params.documentId) !== openEpoch) {
        throw new VdeError('E_DOCUMENT_NOT_OPEN', 'The document is not open.', {
          documentId: params.documentId,
        });
      }
    }
    // If the permission was revoked while rendering, do not issue.
    const permission = permissionOf();
    const { record, entry, snapshot } = prepared;
    // If the question ended while rendering (cancelled, submitted, or forgotten), do not issue an SDK-enabled view (spec 11.6).
    if (params.requestId !== null) {
      const request = Object.hasOwn(store.payload.feedbackRequests, params.requestId)
        ? store.payload.feedbackRequests[params.requestId]
        : undefined;
      if (!request) {
        throw new VdeError('E_REQUEST_NOT_FOUND', 'The question was not found.', {
          requestId: params.requestId,
        });
      }
      if (request.status !== 'pending') {
        throw new VdeError('E_REQUEST_NOT_PENDING', 'The question is not pending.', {
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
          'This view cannot send draft answers for that question from the HTML.',
          {
            requestId: params.requestId,
          },
        );
      }
    }
    if (interactive && snapshot.format !== 'html') {
      throw new VdeError('E_INVALID_ARGUMENT', 'interactive is only available for HTML documents.');
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
    // 256-bit random value. Usable only to view this document and revision, never for the management API.
    const key = randomBytes(32).toString('base64url');
    grants.set(key, {
      documentId: record.documentId,
      openEpoch,
      revision: entry.revision,
      mode: params.mode,
      permission,
      snapshot,
      bridge,
      missing: new Set(),
    });
    // Bound retained views across the daemon. Excess grants are revoked oldest first.
    while (grants.size > LIMITS.renderGrants) {
      const oldest = grants.keys().next().value;
      if (oldest === undefined) break;
      grants.delete(oldest);
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
      headingTargets: snapshot.headingTargets,
      bridge:
        bridge === null ? null : { instanceId: bridge.instanceId, requestId: bridge.requestId },
    };
  };

  return {
    get grantCount() {
      return grants.size;
    },
    retainedCounts() {
      return { grants: grants.size, snapshots: snapshots.size };
    },

    async createGrant(rawParams, context) {
      const params = renderGrantParamsSchema.parse(rawParams);
      return issue({ ...params, requestId: null }, context);
    },

    async createGrantForRequest(requestId, context) {
      const request = Object.hasOwn(store.payload.feedbackRequests, requestId)
        ? store.payload.feedbackRequests[requestId]
        : undefined;
      if (!request) {
        throw new VdeError('E_REQUEST_NOT_FOUND', 'The question was not found.', { requestId });
      }
      if (request.status !== 'pending') {
        throw new VdeError('E_REQUEST_NOT_PENDING', 'The question is not pending.', {
          requestId,
          status: request.status,
        });
      }
      // A question created as static does not become interactive even if scripts are allowed later.
      // A question created as interactive falls back to the static view if the script permission was revoked.
      const interactive =
        request.renderMode === 'interactive' && documents.interactiveAllowed(request.documentId);
      return issue(
        {
          documentId: request.documentId,
          revision: request.revision,
          mode: interactive ? 'interactive' : 'static',
          requestId: interactive ? request.requestId : null,
        },
        context,
      );
    },

    bridgeOf(key) {
      const grant = liveGrant(key);
      if (!grant?.bridge) return null;
      const request = store.payload.feedbackRequests[grant.bridge.requestId];
      if (request?.status !== 'pending') return null;
      return {
        requestId: grant.bridge.requestId,
        documentId: grant.documentId,
        revision: grant.revision,
      };
    },

    release(keys) {
      let released = 0;
      for (const key of keys) {
        if (grants.delete(key)) released += 1;
      }
      return released;
    },

    async resolve(key, logicalPath) {
      const grant = liveGrant(key);
      if (!grant) return null;
      // Looked up only by exact match with a registered path. Never resolved to a filesystem path.
      const file = grant.snapshot.files.get(logicalPath);
      if (!file) {
        // Records loads of unregistered files so the UI can show how to register them (spec 10.3).
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
      // If the grant was revoked while reading the content, do not serve it.
      if (!liveGrant(key)) return null;
      return { body, mime: file.mime, role: file.role, grant: key, mode: grant.mode };
    },

    missingOf(key) {
      const grant = liveGrant(key);
      if (!grant) return [];
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
        throw new VdeError('E_LINK_NOT_FOUND', 'The link was not found.', { documentId, linkId });
      }
      return link;
    },
  };
}
