import { describe, expect, it } from 'vitest';

import type { DocumentSummary } from '@vde-open/shared';

import { ApiError, type Api } from './api.ts';
import { createPdfExports, describeExportFailure } from './pdf-export.ts';

const failure = (
  code: string,
  message = 'from the daemon',
  details: Record<string, unknown> = {},
) => new ApiError(code, message, 400, details);

describe('messages for a failed PDF export', () => {
  it('shows what the daemon says about a missing browser', () => {
    expect(
      describeExportFailure(failure('E_BROWSER_NOT_FOUND', 'Exporting a PDF needs Google Chrome.')),
    ).toBe('Exporting a PDF needs Google Chrome.');
  });

  it('tells a timeout apart from other printing failures', () => {
    expect(describeExportFailure(failure('E_EXPORT_FAILED', 'x', { reason: 'timeout' }))).toBe(
      'The browser did not finish printing the PDF in time.',
    );
    expect(describeExportFailure(failure('E_EXPORT_FAILED', 'x', { reason: 'exit' }))).toBe(
      'The browser could not print the PDF.',
    );
  });

  it('explains a revision that is gone, a document that cannot be prepared, and a full queue', () => {
    expect(describeExportFailure(failure('E_REVISION_UNAVAILABLE'))).toContain('no longer kept');
    expect(describeExportFailure(failure('E_PARSE_FAILED'))).toContain('could not be prepared');
    expect(
      describeExportFailure(failure('E_LIMIT_EXCEEDED', 'x', { reason: 'waiting' })),
    ).toContain('still waiting');
    expect(
      describeExportFailure(failure('E_LIMIT_EXCEEDED', 'x', { reason: 'page-size' })),
    ).toContain('too large to print');
    expect(describeExportFailure(failure('E_DAEMON_STOPPING', 'The daemon is stopping.'))).toBe(
      'Could not export the PDF. The daemon is stopping.',
    );
    expect(describeExportFailure(new TypeError('Failed to fetch'))).toBe(
      'Could not export the PDF.',
    );
  });
});

describe('PDF exports kept by document', () => {
  const document = {
    documentId: 'doc_1',
    displayPath: 'docs/設計.md',
    title: '設計',
  } as DocumentSummary;

  function deferred() {
    let resolve!: (pdf: Blob) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Blob>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('saves the file when the export finishes, and ignores a second start meanwhile', async () => {
    const saved: Array<[Blob, string]> = [];
    const exports = createPdfExports((pdf, name) => saved.push([pdf, name]));
    const pending = deferred();
    const calls: string[] = [];
    const api = {
      exportPdf: (documentId: string, revision: string) => {
        calls.push(`${documentId}@${revision}`);
        return pending.promise;
      },
    } as unknown as Api;
    let notified = 0;
    exports.subscribe(() => {
      notified += 1;
    });

    exports.start(api, document, 'rev_1');
    exports.start(api, document, 'rev_1');
    expect(calls).toEqual(['doc_1@rev_1']);
    expect(exports.state('doc_1')).toEqual({ exporting: true, error: null });
    expect(exports.state('doc_2')).toEqual({ exporting: false, error: null });

    const pdf = new Blob(['%PDF-']);
    pending.resolve(pdf);
    await pending.promise;
    await Promise.resolve();
    expect(saved).toEqual([[pdf, '設計.pdf']]);
    expect(exports.state('doc_1')).toEqual({ exporting: false, error: null });
    expect(notified).toBe(2);
  });

  it('keeps a failure for the document until the next export', async () => {
    const exports = createPdfExports(() => undefined);
    const first = deferred();
    const api = { exportPdf: () => first.promise } as unknown as Api;
    exports.start(api, document, 'rev_1');
    first.reject(new ApiError('E_EXPORT_FAILED', 'x', 500, { reason: 'timeout' }));
    await first.promise.catch(() => undefined);
    await Promise.resolve();
    expect(exports.state('doc_1')).toEqual({
      exporting: false,
      error: 'The browser did not finish printing the PDF in time.',
    });
    // The snapshot is stable while nothing changes (useSyncExternalStore relies on it).
    expect(exports.state('doc_1')).toBe(exports.state('doc_1'));

    exports.dismiss('doc_1');
    expect(exports.state('doc_1')).toEqual({ exporting: false, error: null });

    const second = deferred();
    exports.start({ exportPdf: () => second.promise } as unknown as Api, document, 'rev_1');
    expect(exports.state('doc_1')).toEqual({ exporting: true, error: null });
    // An export in progress is not dismissed.
    exports.dismiss('doc_1');
    expect(exports.state('doc_1')).toEqual({ exporting: true, error: null });
  });
});
