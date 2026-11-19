import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeDocument, HTML_STATIC_PARSER_PROFILE } from '@vde-open/document';
import { renderDocument, scanReferences } from '@vde-open/document/render';
import { LIMITS } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCursorCodec } from '../documents/cursor.ts';
import { computeRevision } from '../documents/revision.ts';
import { DocumentService } from '../documents/service.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createWatchService } from '../watch/watch-service.ts';
import type { ParseService } from '../workers/parse-service.ts';
import { createRenderService, type RenderService } from './render-service.ts';
import { createViewEpochs, type ViewEpochs } from './view-epochs.ts';

let base: string;
let store: StateStore;
let documents: DocumentService;
let render: RenderService;
// Hold the render until signalled.
let holdRender: Promise<void> | null;
let renderStarted: () => void;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-render-')));
  store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  documents = new DocumentService({ store, cursors: createCursorCodec(randomBytes(32)) });
  holdRender = null;
  renderStarted = () => undefined;
  const parse: ParseService = {
    diagnostics: () => Promise.resolve(null),
    analyze: (format, text) => Promise.resolve(analyzeDocument(text, format)),
    scan: (kind, text) => Promise.resolve(scanReferences(kind, text)),
    render: async (input) => {
      renderStarted();
      if (holdRender) await holdRender;
      return renderDocument(input);
    },
    print: () => Promise.reject(new Error('Not used by the render service.')),
    printHtml: () => Promise.reject(new Error('Not used by the render service.')),
    close: () => Promise.resolve(),
  };
  render = createRenderService({
    store,
    documents,
    parse,
    previewOrigin: () => 'http://127.0.0.1:1',
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  const path = join(base, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

async function openDocument(): Promise<string> {
  write('site/index.html', '<p>Body</p>');
  const opened = await documents.open({ cwd: base, paths: ['site/index.html'] });
  return opened.data.documents[0]?.documentId as string;
}

// Holds once the render starts. Calling the returned function resumes it.
function pauseRender(): { started: Promise<void>; resume: () => void } {
  let resume: () => void = () => undefined;
  holdRender = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    renderStarted = resolve;
  });
  return { started, resume };
}

const GRANT_CONTEXT = { origin: 'http://127.0.0.1:1' };

describe('SEC-015 ordering of render grants and closing a document', () => {
  it('does not issue a grant if the document is closed while rendering', async () => {
    const documentId = await openDocument();
    const paused = pauseRender();
    const issuing = render.createGrant({ documentId }, GRANT_CONTEXT);
    await paused.started;

    await documents.close({ cwd: base, targets: [documentId] });
    paused.resume();
    await expect(issuing).rejects.toMatchObject({ code: 'E_DOCUMENT_NOT_OPEN' });
    expect(render.grantCount).toBe(0);
  });

  it('if closed and reopened while rendering, the issue started before the close does not take effect as is', async () => {
    const documentId = await openDocument();
    const paused = pauseRender();
    const issuing = render.createGrant({ documentId }, GRANT_CONTEXT);
    await paused.started;

    await documents.close({ cwd: base, targets: [documentId] });
    await documents.open({ cwd: base, paths: ['site/index.html'] });
    holdRender = null;
    paused.resume();
    // Issues for the reopened document after re-checking that it is open.
    const grant = await issuing;
    expect(render.grantCount).toBe(1);
    expect(await render.resolve(grant.grant, 'index.html')).not.toBeNull();

    // This grant belongs to the reopened document. The next close revokes it, and reopening does not bring it back.
    await documents.close({ cwd: base, targets: [documentId] });
    expect(await render.resolve(grant.grant, 'index.html')).toBeNull();
    await documents.open({ cwd: base, paths: ['site/index.html'] });
    expect(await render.resolve(grant.grant, 'index.html')).toBeNull();
  });

  it('an issued grant is unusable after reopen, even without waiting for the cleanup at close', async () => {
    const documentId = await openDocument();
    const grant = await render.createGrant({ documentId }, GRANT_CONTEXT);
    expect(await render.resolve(grant.grant, 'index.html')).not.toBeNull();

    // Close and reopen without calling the cleanup (pruneClosed).
    await documents.close({ cwd: base, targets: [documentId] });
    await documents.open({ cwd: base, paths: ['site/index.html'] });
    expect(await render.resolve(grant.grant, 'index.html')).toBeNull();

    // A grant issued after the reopen is usable.
    const fresh = await render.createGrant({ documentId }, GRANT_CONTEXT);
    expect(await render.resolve(fresh.grant, 'index.html')).not.toBeNull();
  });

  it('does not mix up render results of identical documents at different locations', async () => {
    write('site/a.html', '<p>Same</p>');
    write('site/b.html', '<p>Same</p>');
    const opened = await documents.open({ cwd: base, paths: ['site/a.html', 'site/b.html'] });
    const [a, b] = opened.data.documents.map((document) => document.documentId) as [string, string];
    const grantA = await render.createGrant({ documentId: a }, GRANT_CONTEXT);
    const grantB = await render.createGrant({ documentId: b }, GRANT_CONTEXT);
    expect(grantA.revision).toBe(grantB.revision);
    expect([grantA.documentLogicalPath, grantB.documentLogicalPath]).toEqual(['a.html', 'b.html']);
    expect(await render.resolve(grantB.grant, 'a.html')).toBeNull();
    expect(await render.resolve(grantB.grant, 'b.html')).not.toBeNull();
  });
});

describe('interactive view and communication with the HTML', () => {
  const questionnaire = JSON.stringify({
    schemaVersion: 1,
    title: 'Confirm',
    fieldOrder: ['ok'],
    answerSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean', title: 'OK' } },
      required: [],
      additionalProperties: false,
    },
  });

  async function openInteractive(): Promise<string> {
    write('site/app.html', '<p id="x">Body</p><script>document.title = "ran"</script>');
    const opened = await documents.open({
      cwd: base,
      paths: ['site/app.html'],
      htmlMode: 'interactive',
    });
    return opened.data.documents[0]?.documentId as string;
  }

  async function ask(documentId: string) {
    const { FeedbackService } = await import('../feedback/service.ts');
    const feedback = new FeedbackService({ store, documents });
    return (await feedback.create({ cwd: base, questionnaire, documentId })).data.request;
  }

  const body = async (grant: string, path: string) =>
    (await render.resolve(grant, path))?.body.toString('utf8') ?? null;

  it('does not issue an interactive view for a document without script permission', async () => {
    const documentId = await openDocument();
    await expect(
      render.createGrant({ documentId, mode: 'interactive' }, GRANT_CONTEXT),
    ).rejects.toMatchObject({ code: 'E_INTERACTIVE_NOT_ALLOWED' });
  });

  it('the interactive view keeps scripts, and the SDK is included only in views of pending questions created as interactive', async () => {
    const documentId = await openInteractive();
    const plain = await render.createGrant({ documentId, mode: 'interactive' }, GRANT_CONTEXT);
    expect(plain.bridge).toBeNull();
    const plainHtml = await body(plain.grant, plain.documentLogicalPath);
    expect(plainHtml).toContain('<script>document.title');
    expect(plainHtml).not.toContain('vde-bridge-hello');
    expect((await render.resolve(plain.grant, plain.documentLogicalPath))?.mode).toBe(
      'interactive',
    );

    const request = await ask(documentId);
    const bridged = await render.createGrantForRequest(request.requestId, GRANT_CONTEXT);
    expect(bridged).toMatchObject({ mode: 'interactive', revision: request.revision });
    expect(bridged.bridge).toEqual({
      instanceId: expect.any(String),
      requestId: request.requestId,
    });
    const html = await body(bridged.grant, bridged.documentLogicalPath);
    // The SDK is the first script and holds only the per-view config (the identifier and the allowed parent origin).
    expect(html?.indexOf('vde-bridge-hello')).toBeLessThan(html?.indexOf('document.title') ?? 0);
    expect(html).toContain(
      JSON.stringify({
        instanceId: bridged.bridge?.instanceId,
        parentOrigin: GRANT_CONTEXT.origin,
      }),
    );
    expect(html).not.toContain('__vde_bridge_config_');
    // A question cannot be specified when issuing a document view.
    await expect(
      render.createGrant({ documentId, requestId: request.requestId }, GRANT_CONTEXT),
    ).rejects.toThrow();
  });

  it('a question view is issued with the revision and view mode pinned by the question; a question created as static does not run scripts even if allowed later', async () => {
    write('site/app.html', '<p>Version 1</p><script>1</script>');
    const opened = await documents.open({ cwd: base, paths: ['site/app.html'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    const staticRequest = await ask(documentId);
    await documents.open({ cwd: base, paths: ['site/app.html'], htmlMode: 'interactive' });
    expect(documents.interactiveAllowed(documentId)).toBe(true);
    const pinned = await render.createGrantForRequest(staticRequest.requestId, GRANT_CONTEXT);
    expect(pinned).toMatchObject({ mode: 'static', bridge: null });
    expect(await body(pinned.grant, pinned.documentLogicalPath)).not.toContain('<script');

    // A question created as interactive also falls back to the static view (no SDK) once the permission is revoked. The question's revision is shown even after a new revision.
    const { FeedbackService } = await import('../feedback/service.ts');
    await new FeedbackService({ store, documents }).cancel(
      { requestId: staticRequest.requestId },
      'agent',
    );
    const interactiveRequest = await ask(documentId);
    write('site/app.html', '<p>Version 2</p>');
    await documents.open({ cwd: base, paths: ['site/app.html'] });
    await documents.setHtmlMode({ documentId, mode: 'static' });
    const revoked = await render.createGrantForRequest(interactiveRequest.requestId, GRANT_CONTEXT);
    expect(revoked).toMatchObject({
      mode: 'static',
      bridge: null,
      revision: interactiveRequest.revision,
    });
    expect(await body(revoked.grant, revoked.documentLogicalPath)).toContain('Version 1');
  });

  it('revoking the script permission ends issued interactive views, and re-granting does not revive them', async () => {
    const documentId = await openInteractive();
    // A failed lookup drops the grant, so each moment needs its own grant.
    const revoked = await render.createGrant({ documentId, mode: 'interactive' }, GRANT_CONTEXT);
    const regranted = await render.createGrant({ documentId, mode: 'interactive' }, GRANT_CONTEXT);
    expect(await body(revoked.grant, revoked.documentLogicalPath)).not.toBeNull();
    expect(await body(regranted.grant, regranted.documentLogicalPath)).not.toBeNull();
    await documents.setHtmlMode({ documentId, mode: 'static' });
    expect(await render.resolve(revoked.grant, revoked.documentLogicalPath)).toBeNull();
    // Re-grant without touching the previous view.
    await documents.setHtmlMode({ documentId, mode: 'interactive', confirmed: true });
    expect(await render.resolve(regranted.grant, regranted.documentLogicalPath)).toBeNull();
    // Reopening with the same option while allowed keeps issued views usable.
    const current = await render.createGrant({ documentId, mode: 'interactive' }, GRANT_CONTEXT);
    await documents.open({ cwd: base, paths: ['site/app.html'], htmlMode: 'interactive' });
    expect(await body(current.grant, current.documentLogicalPath)).not.toBeNull();
  });

  it('bounds retained grants and revokes only the oldest view when the limit is exceeded', async () => {
    const documentId = await openInteractive();
    const first = await render.createGrant({ documentId }, GRANT_CONTEXT);
    const second = await render.createGrant({ documentId }, GRANT_CONTEXT);
    for (let index = 2; index <= LIMITS.renderGrants; index += 1) {
      await render.createGrant({ documentId }, GRANT_CONTEXT);
    }
    expect(render.grantCount).toBe(LIMITS.renderGrants);
    expect(await render.resolve(first.grant, first.documentLogicalPath)).toBeNull();
    expect(await render.resolve(second.grant, second.documentLogicalPath)).not.toBeNull();
    expect(render.release([second.grant])).toBe(1);
    expect(render.release([second.grant])).toBe(0);
  });

  it('operations from an SDK-enabled view work only while the grant is valid and the question is pending', async () => {
    const documentId = await openInteractive();
    const request = await ask(documentId);
    const bridged = await render.createGrantForRequest(request.requestId, GRANT_CONTEXT);
    expect(render.bridgeOf(bridged.grant)).toEqual({
      requestId: request.requestId,
      documentId,
      revision: request.revision,
    });
    expect(render.bridgeOf('unknown-grant')).toBeNull();
    // Not available for a view without the SDK.
    const plain = await render.createGrant({ documentId, mode: 'interactive' }, GRANT_CONTEXT);
    expect(render.bridgeOf(plain.grant)).toBeNull();
    // A released grant is unusable.
    render.release([bridged.grant]);
    expect(render.bridgeOf(bridged.grant)).toBeNull();
    // Unusable once the question ends.
    const again = await render.createGrantForRequest(request.requestId, GRANT_CONTEXT);
    const { FeedbackService } = await import('../feedback/service.ts');
    await new FeedbackService({ store, documents }).cancel(
      { requestId: request.requestId },
      'agent',
    );
    expect(render.bridgeOf(again.grant)).toBeNull();
    await expect(
      render.createGrantForRequest(request.requestId, GRANT_CONTEXT),
    ).rejects.toMatchObject({ code: 'E_REQUEST_NOT_PENDING' });
  });

  it.each(['cancel', 'forget'] as const)(
    'does not issue an SDK-enabled view if the question ends (%s) while rendering',
    async (ending) => {
      const documentId = await openInteractive();
      const request = await ask(documentId);
      const { FeedbackService } = await import('../feedback/service.ts');
      const feedback = new FeedbackService({ store, documents });
      const paused = pauseRender();
      const issuing = render.createGrantForRequest(request.requestId, GRANT_CONTEXT);
      await paused.started;
      await feedback.cancel({ requestId: request.requestId }, 'agent');
      if (ending === 'forget') {
        await feedback.forget({ requestId: request.requestId, confirmed: true });
      }
      paused.resume();
      await expect(issuing).rejects.toMatchObject({
        code: ending === 'forget' ? 'E_REQUEST_NOT_FOUND' : 'E_REQUEST_NOT_PENDING',
      });
      expect(render.grantCount).toBe(0);
    },
  );

  it('records and reports loads of unregistered files per view', async () => {
    const notified: string[] = [];
    const tracking = createRenderService({
      store,
      documents,
      parse: {
        diagnostics: () => Promise.resolve(null),
        analyze: (format, text) => Promise.resolve(analyzeDocument(text, format)),
        scan: (kind, text) => Promise.resolve(scanReferences(kind, text)),
        render: (input) => Promise.resolve(renderDocument(input)),
        print: () => Promise.reject(new Error('Not used by the render service.')),
        printHtml: () => Promise.reject(new Error('Not used by the render service.')),
        close: () => Promise.resolve(),
      },
      previewOrigin: () => 'http://127.0.0.1:1',
      onMissing: (documentId) => notified.push(documentId),
    });
    const documentId = await openInteractive();
    const { grant } = await tracking.createGrant(
      { documentId, mode: 'interactive' },
      GRANT_CONTEXT,
    );
    expect(await tracking.resolve(grant, 'data.json')).toBeNull();
    expect(await tracking.resolve(grant, 'data.json')).toBeNull();
    expect(await tracking.resolve(grant, 'mod.js')).toBeNull();
    expect(tracking.missingOf(grant)).toEqual(['data.json', 'mod.js']);
    expect(tracking.missingOf('unknown-grant')).toEqual([]);
    // The same file is reported only once.
    expect(notified).toEqual([documentId, documentId]);
  });
});

describe('headings the HTML view can be moved to', () => {
  const questionnaire = JSON.stringify({
    schemaVersion: 1,
    title: 'Confirm',
    fieldOrder: ['ok'],
    answerSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean', title: 'OK' } },
      required: [],
      additionalProperties: false,
    },
  });
  const parse: ParseService = {
    diagnostics: () => Promise.resolve(null),
    analyze: (format, text) => Promise.resolve(analyzeDocument(text, format)),
    scan: (kind, text) => Promise.resolve(scanReferences(kind, text)),
    render: (input) => Promise.resolve(renderDocument(input)),
    print: () => Promise.reject(new Error('Not used by the render service.')),
    printHtml: () => Promise.reject(new Error('Not used by the render service.')),
    close: () => Promise.resolve(),
  };
  const HTML = '<h1>A</h1><object><h2>B</h2></object><h2>C</h2>';

  it('after a restart, file documents analyzed with an older profile get a current revision, and older revisions stay readable', async () => {
    write('site/a.html', HTML);
    const fileId = (await documents.open({ cwd: base, paths: ['site/a.html'] })).data.documents[0]
      ?.documentId as string;
    const stdinId = (
      await documents.open({ cwd: base, paths: [], stdin: { content: HTML }, format: 'html' })
    ).data.documents[0]?.documentId as string;
    const { FeedbackService } = await import('../feedback/service.ts');
    const request = (
      await new FeedbackService({ store, documents }).create({
        cwd: base,
        questionnaire,
        documentId: fileId,
      })
    ).data.request;

    // Leave the state as a daemon with the older profile would: the same content and assets, with the revisions computed under it.
    const older = new Map<string, string>();
    await store.transaction((tx) => {
      for (const record of Object.values(tx.state.documents)) {
        for (const entry of record.revisions) {
          const revision = computeRevision({
            format: entry.format,
            sourceSha256: entry.sourceSha256,
            parserProfileVersion: 'html-static-v1',
            assets: entry.assets.map(({ logicalPath, mime, role, sha256 }) => ({
              logicalPath,
              mime,
              role,
              sha256,
            })),
          });
          older.set(entry.revision, revision);
          entry.revision = revision;
          entry.parserProfileVersion = 'html-static-v1';
        }
        if (record.currentRevision !== null) {
          record.currentRevision = older.get(record.currentRevision) ?? record.currentRevision;
        }
      }
      for (const pending of Object.values(tx.state.feedbackRequests)) {
        pending.revision = older.get(pending.revision) ?? pending.revision;
      }
    });
    const pinned = older.get(request.revision) as string;
    const stdinRevision = store.payload.documents[stdinId]?.currentRevision;
    await store.close();

    store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
    const restarted = new DocumentService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      analyze: parse.analyze,
    });
    const restartedRender = createRenderService({
      store,
      documents: restarted,
      parse,
      previewOrigin: () => 'http://127.0.0.1:1',
    });
    const watcher = createWatchService({ documents: restarted, debounceMs: 20 });
    try {
      watcher.sync();
      const deadline = Date.now() + 10_000;
      while ((await restarted.read({ documentId: fileId })).data.revision === pinned) {
        if (Date.now() > deadline) throw new Error('The file document was not read again.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const current = store.payload.documents[fileId];
      expect(current?.currentRevision).not.toBe(pinned);
      expect(
        current?.revisions.find((entry) => entry.revision === current.currentRevision)
          ?.parserProfileVersion,
      ).toBe(HTML_STATIC_PARSER_PROFILE);
      // A stdin document has nothing to read again and keeps its revision.
      expect(store.payload.documents[stdinId]?.currentRevision).toBe(stdinRevision);
      expect((await restarted.read({ documentId: stdinId })).data.revision).toBe(stdinRevision);

      // The revision the question pins is still served, analyzed and transformed by the current code.
      const outline = (
        await restarted.read({ documentId: fileId, outline: true, revision: pinned })
      ).data.outline;
      expect(outline?.map((item) => [item.sectionId, item.anchor])).toEqual([
        ['sec_0001', 'h1'],
        ['sec_0002', 'h2'],
        ['sec_0003', 'h3'],
      ]);
      const grant = await restartedRender.createGrantForRequest(request.requestId, GRANT_CONTEXT);
      expect(grant).toMatchObject({ revision: pinned, mode: 'static' });
      expect(grant.headingTargets).toEqual([
        { sectionId: 'sec_0001', anchor: 'h1' },
        { sectionId: 'sec_0003', anchor: 'h3' },
      ]);
      const html = (
        await restartedRender.resolve(grant.grant, grant.documentLogicalPath)
      )?.body.toString('utf8');
      expect(html).toContain('<h1 id="h1">A</h1>');
      expect(html).toContain('<h2 id="h3">C</h2>');
    } finally {
      await watcher.close();
    }
  });
});

describe('phone reader grants (ADR-0017)', () => {
  let phone: RenderService;
  let views: ViewEpochs;

  beforeEach(() => {
    // Like the daemon: every document event advances the view generations.
    documents = new DocumentService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      emit: () => views.observe(),
    });
    views = createViewEpochs(documents);
    const parse: ParseService = {
      diagnostics: () => Promise.resolve(null),
      analyze: (format, text) => Promise.resolve(analyzeDocument(text, format)),
      scan: (kind, text) => Promise.resolve(scanReferences(kind, text)),
      render: async (input) => {
        renderStarted();
        if (holdRender) await holdRender;
        return renderDocument(input);
      },
      print: () => Promise.reject(new Error('unused')),
      printHtml: () => Promise.reject(new Error('unused')),
      close: () => Promise.resolve(),
    };
    phone = createRenderService({
      store,
      documents,
      parse,
      previewOrigin: () => 'http://127.0.0.1:1',
      mobile: {
        previewOrigin: () => 'https://mac.example.ts.net:43183',
        viewEpochOf: (documentId) => views.of(documentId),
      },
    });
  });

  const current = (documentId: string) => ({
    revision: documents.state.documents[documentId]?.currentRevision ?? '',
    viewEpoch: views.of(documentId),
  });
  const allow = (documentId: string, mode: 'static' | 'interactive') =>
    documents.setHtmlMode({ documentId, mode, confirmed: true });

  it('a permission change while rendering refuses the grant as a changed view', async () => {
    const documentId = await openDocument();
    await allow(documentId, 'interactive');
    const paused = pauseRender();
    const issuing = phone.createMobileGrant(documentId, current(documentId));
    await paused.started;
    await allow(documentId, 'static');
    paused.resume();
    await expect(issuing).rejects.toMatchObject({ code: 'E_VIEW_STALE' });
    expect(phone.grantCount).toBe(0);
  });

  it('a close and reopen while rendering refuses the grant; so does a new revision', async () => {
    const documentId = await openDocument();
    let paused = pauseRender();
    let issuing = phone.createMobileGrant(documentId, current(documentId));
    await paused.started;
    await documents.close({ cwd: base, targets: [documentId] });
    await documents.open({ cwd: base, paths: ['site/index.html'] });
    paused.resume();
    await expect(issuing).rejects.toMatchObject({
      code: expect.stringMatching(/E_VIEW_STALE|E_DOCUMENT_NOT_OPEN/),
    });

    // A revision not rendered yet, so the next issue renders (and can be held).
    holdRender = null;
    write('site/index.html', '<p>Second</p>');
    await documents.refresh({ documentId });
    paused = pauseRender();
    issuing = phone.createMobileGrant(documentId, current(documentId));
    await paused.started;
    write('site/index.html', '<p>Third</p>');
    await documents.refresh({ documentId });
    paused.resume();
    await expect(issuing).rejects.toMatchObject({ code: 'E_VIEW_STALE' });
    expect(phone.grantCount).toBe(0);
  });

  it('the view generation never returns to an earlier value across Static -> Interactive -> Static', async () => {
    const documentId = await openDocument();
    const seen = [views.of(documentId)];
    await allow(documentId, 'interactive');
    seen.push(views.of(documentId));
    await allow(documentId, 'static');
    seen.push(views.of(documentId));
    expect(new Set(seen).size).toBe(3);
    // Focus does not advance it.
    await documents.focus({ documentId });
    expect(views.of(documentId)).toBe(seen[2]);
  });

  it('phone and PC grants are served, released, and bounded only within their own audience', async () => {
    const documentId = await openDocument();
    const pc = await phone.createGrant({ documentId }, GRANT_CONTEXT);
    const mobile = await phone.createMobileGrant(documentId, current(documentId));
    expect(mobile.documentUrl?.startsWith('https://mac.example.ts.net:43183/r/')).toBe(true);
    expect(await phone.resolve(mobile.grant, 'index.html')).toBeNull();
    expect(await phone.resolveMobile(pc.grant, 'index.html')).toBeNull();
    expect(phone.release([mobile.grant])).toBe(0);
    expect(phone.releaseMobile([pc.grant])).toBe(0);
    expect(phone.checkMobile(mobile.grant)).toBe(true);
    expect(await phone.resolve(pc.grant, 'index.html')).not.toBeNull();

    const phoneGrants = [mobile.grant];
    for (let index = 0; index < LIMITS.renderGrants; index += 1) {
      phoneGrants.push((await phone.createMobileGrant(documentId, current(documentId))).grant);
    }
    expect(phone.checkMobile(phoneGrants[0] ?? '')).toBe(false);
    expect(phone.checkMobile(phoneGrants[1] ?? '')).toBe(true);
    expect(await phone.resolve(pc.grant, 'index.html')).not.toBeNull();
  });
});
