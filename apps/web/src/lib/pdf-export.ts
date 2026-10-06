import { pdfFileName, type DocumentSummary } from '@vde-open/shared';
import { useSyncExternalStore } from 'react';

import { ApiError, type Api } from '@/lib/api';

// The message shown when a PDF export fails. Messages the daemon writes for the user (a missing browser) are shown as they are.
export function describeExportFailure(reason: unknown): string {
  if (!(reason instanceof ApiError)) return 'Could not export the PDF.';
  switch (reason.code) {
    case 'E_BROWSER_NOT_FOUND':
      return reason.message;
    case 'E_REVISION_UNAVAILABLE':
      return 'This revision is no longer kept. Show the latest revision and export again.';
    case 'E_PARSE_FAILED':
      return 'The document could not be prepared for printing (it is too large or too deeply nested).';
    case 'E_LIMIT_EXCEEDED':
      return reason.details['reason'] === 'page-size'
        ? 'The document is too large to print (its images make the page too large).'
        : 'Other PDF exports are still waiting. Try again after they finish.';
    case 'E_EXPORT_FAILED':
      return reason.details['reason'] === 'timeout'
        ? 'The browser did not finish printing the PDF in time.'
        : 'The browser could not print the PDF.';
    default:
      return `Could not export the PDF. ${reason.message}`;
  }
}

export interface PdfExportState {
  exporting: boolean;
  error: string | null;
}

const IDLE: PdfExportState = { exporting: false, error: null };

function saveFile(pdf: Blob, fileName: string): void {
  const url = URL.createObjectURL(pdf);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = fileName;
  window.document.body.append(link);
  link.click();
  link.remove();
  // Revoke after the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// PDF exports by document. Kept outside the viewer, which is recreated when another document is shown:
// an export keeps going and saves its file, and a failure is still shown when the document is shown again.
export function createPdfExports(save: (pdf: Blob, fileName: string) => void = saveFile) {
  const states = new Map<string, PdfExportState>();
  const listeners = new Set<() => void>();
  const set = (documentId: string, state: PdfExportState) => {
    if (state === IDLE) states.delete(documentId);
    else states.set(documentId, state);
    for (const listener of listeners) listener();
  };
  return {
    state: (documentId: string): PdfExportState => states.get(documentId) ?? IDLE,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Export one revision. Ignored while the same document is already exporting.
    start(api: Api, document: DocumentSummary, revision: string): void {
      const { documentId } = document;
      if (states.get(documentId)?.exporting === true) return;
      set(documentId, { exporting: true, error: null });
      api.exportPdf(documentId, revision).then(
        (pdf) => {
          set(documentId, IDLE);
          save(pdf, pdfFileName(document));
        },
        (reason: unknown) => {
          set(documentId, { exporting: false, error: describeExportFailure(reason) });
        },
      );
    },
    // Hide the failure shown for the document.
    dismiss(documentId: string): void {
      if (states.get(documentId)?.exporting === false) set(documentId, IDLE);
    },
  };
}

export const pdfExports = createPdfExports();

export function usePdfExport(documentId: string): PdfExportState {
  return useSyncExternalStore(pdfExports.subscribe, () => pdfExports.state(documentId));
}
