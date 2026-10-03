import type { RenderDiagnostic } from '@vde-open/shared';

// Turn each difference between the original document and the view into a sentence that names the target, the reason, and the fix (spec 13.4).
// Do not just say "for safety"; say what happened and what is needed to show it.
type Describe = (target: string, count: number) => string;

// "1 script" / "3 scripts".
const plural = (count: number, noun: string) => `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

const DESCRIPTIONS: Record<string, Describe> = {
  'asset-scan-failed': () =>
    'Scanning the files this document references did not finish in time or exceeded the structure limits, so images and CSS were not registered. Run vo refresh <document ID> to scan again.',
  'script-removed': (_target, count) =>
    `Removed ${plural(count, 'script')}. Scripts do not run in this view, so content that scripts would create is not shown.`,
  'script-not-loaded': (_target, count) =>
    `Removed ${plural(count, 'script')} that could not be loaded (referencing unregistered files or external URLs).`,
  'noscript-removed': (_target, count) =>
    `Removed ${plural(count, 'noscript element')}. In the Interactive view, noscript content is not shown.`,
  'asset-requested': (target) =>
    `The view tried to load ${target}, but it is not registered, so it could not be loaded. Register it with vo open <document> --assets-root <dir> --asset ${target} to make it loadable (files that scripts load at run time are not registered automatically).`,
  'event-handler-removed': (_target, count) =>
    `Removed event attributes such as onclick from ${plural(count, 'element')}.`,
  'embed-removed': (_target, count) =>
    `Removed ${plural(count, 'embedded element')} (iframe, object, embed, and similar). Other pages and plugins cannot be embedded.`,
  'inline-svg-removed': (_target, count) =>
    `Removed ${plural(count, 'inline SVG')}. Save the SVG as a file (.svg) and reference it with <img> to show it.`,
  'mathml-removed': (_target, count) => `Removed ${plural(count, 'MathML element')}.`,
  'meta-refresh-removed': () => 'Removed the automatic redirect (meta refresh).',
  'base-removed': () =>
    'Removed the base element. Relative references resolve against the document location.',
  'network-hint-removed': (_target, count) =>
    `Removed ${plural(count, 'resource hint')} (prefetch, preconnect, and similar).`,
  'form-action-removed': () =>
    'Removed the form action. Form controls are display-only and cannot submit.',
  'element-removed': (_target, count) =>
    `Removed ${plural(count, 'legacy element')} that treats the rest of the document as text (such as plaintext).`,
  'media-blocked': (target) => `Video and audio (${target}) cannot be shown.`,
  'remote-asset-blocked': (target) =>
    `External URL (${target}) is not loaded. Put the file under the document's directory and reference it with a relative path to show it.`,
  'asset-not-registered': (target) =>
    `${target} was not found. Make sure the file is under the assets-root used when the document was opened (the document's directory if none was given).`,
  'asset-rejected': (target) =>
    `${target} cannot be loaded. References outside the assets-root, file: URLs, and encoded separators are not allowed. To widen the range, reopen with vo open <document> --assets-root <dir>.`,
  'asset-hidden': (target) =>
    `${target} is not loaded. Files and directories whose names start with "." (such as .env and .git) cannot be referenced from documents.`,
  'asset-unsupported': (target) =>
    `${target} is a file type that cannot be used here. Allowed types are images (PNG, JPEG, WebP, GIF, AVIF, SVG), CSS, fonts (WOFF, WOFF2), and, in the Interactive view, scripts (.js, .mjs) and JSON registered with --asset.`,
  'data-url-blocked': (target) =>
    `data URL (${target}) cannot be used. Only PNG, JPEG, WebP, GIF, and AVIF images are allowed as data URLs.`,
  'css-invalid': (target) =>
    `${target === '' ? 'The CSS in the document' : target} has parts that could not be parsed, and those parts were disabled.`,
  'link-disabled': (_target, count) =>
    `Links in this document (${String(count)}) cannot be clicked inside the view. Open them from the "Links in this document" list.`,
};

export function describeDiagnostic(diagnostic: RenderDiagnostic): string {
  const describe = DESCRIPTIONS[diagnostic.code];
  const target = diagnostic.target ?? '';
  if (!describe) return `${diagnostic.code}${target === '' ? '' : `: ${target}`}`;
  const text = describe(target, diagnostic.count);
  // For kinds that name a target, add the count when the same target appears more than once.
  return diagnostic.target !== null && diagnostic.count > 1
    ? `${text} (${String(diagnostic.count)} occurrences)`
    : text;
}
