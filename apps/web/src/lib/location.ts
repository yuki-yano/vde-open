// The shown document is kept in the query of the management UI URL (?document=<documentId>), so a reload shows it
// again and the browser's back and forward move between documents. The rest of the URL is left as is.
// The heading last jumped to in that document is kept beside it (&section=<sectionId>&heading=<title>).
const DOCUMENT_PARAM = 'document';
const SECTION_PARAM = 'section';
const HEADING_PARAM = 'heading';

export type HistoryMode = 'push' | 'replace';

// A heading of the document in the URL. The section number changes when a heading is added above it, so the title is
// kept too and checked before jumping to it again.
export interface HeadingInUrl {
  sectionId: string;
  title: string;
}

// A request to jump again to the heading in the URL (a reload, back or forward). id tells the requests apart, so the
// view handles each once, including a second one for the document it already shows.
export interface HeadingRestore extends HeadingInUrl {
  id: number;
}

export function documentInUrl(): string | null {
  return new URLSearchParams(window.location.search).get(DOCUMENT_PARAM);
}

export function headingInUrl(): HeadingInUrl | null {
  const params = new URLSearchParams(window.location.search);
  const sectionId = params.get(SECTION_PARAM);
  const title = params.get(HEADING_PARAM);
  return sectionId === null || title === null ? null : { sectionId, title };
}

// Point the URL at the document (null removes it). The heading belongs to the document, so it is dropped when the
// document changes. Does nothing when the URL already points there.
export function writeDocumentToUrl(documentId: string | null, mode: HistoryMode): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get(DOCUMENT_PARAM) !== documentId) {
    url.searchParams.delete(SECTION_PARAM);
    url.searchParams.delete(HEADING_PARAM);
  }
  if (documentId === null) url.searchParams.delete(DOCUMENT_PARAM);
  else url.searchParams.set(DOCUMENT_PARAM, documentId);
  if (url.href === window.location.href) return;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

// Record the heading jumped to (null removes it). Jumps replace the entry, so they add no history.
// Only while the URL names that document: a view that is being left never rewrites the next document's URL.
export function writeHeadingToUrl(documentId: string, heading: HeadingInUrl | null): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get(DOCUMENT_PARAM) !== documentId) return;
  if (heading === null) {
    url.searchParams.delete(SECTION_PARAM);
    url.searchParams.delete(HEADING_PARAM);
  } else {
    url.searchParams.set(SECTION_PARAM, heading.sectionId);
    url.searchParams.set(HEADING_PARAM, heading.title);
  }
  if (url.href === window.location.href) return;
  window.history.replaceState(null, '', url);
}
