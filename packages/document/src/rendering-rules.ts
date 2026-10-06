// How links and images in rendered Markdown are shown. The management UI (MarkdownView) and the print document
// (PDF export) both decide with these functions, so one cannot open more than the other.
import { isSafeLink } from './analysis.ts';
import { classifyLink, classifyReference, dirnameOfLogicalPath } from './references.ts';

// fragment: a heading in the document. external: http(s) or mailto. document: a relative link to a local document,
// which only the host may open after its checks. text: shown as plain text.
export type RenderedLink = 'fragment' | 'external' | 'document' | 'text';

export function renderedLinkOf(href: string | undefined): RenderedLink {
  if (href === undefined || href === '') return 'text';
  if (isSafeLink(href)) return href.startsWith('#') ? 'fragment' : 'external';
  return classifyLink(href).kind === 'document' ? 'document' : 'text';
}

// Logical path of the local file an image reference points to, or null for anything else.
// Whether it is shown also depends on the file being registered for the revision.
export function localImagePath(src: string, documentLogicalPath: string): string | null {
  const reference = classifyReference(src, dirnameOfLogicalPath(documentLogicalPath));
  return reference.kind === 'local' ? reference.logicalPath : null;
}
