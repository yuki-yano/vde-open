import type { Section } from '@vde-open/document';
import { LIMITS, type DocumentFormat, type SearchHit, type SearchMode } from '@vde-open/shared';
import MiniSearch from 'minisearch';

import {
  allowsFuzzy,
  codePointLength,
  normalizeForSearch,
  sliceCodePoints,
  tokenize,
  uniqueTokens,
} from './tokenize.ts';

// Document attributes. Can be changed without re-indexing the content.
export interface IndexedMeta {
  documentId: string;
  revision: string;
  format: DocumentFormat;
  title: string;
  displayPath: string | null;
  // File name and absolute path with symlinks resolved. null for stdin documents.
  fileName: string | null;
  canonicalPath: string | null;
  // Order in the list. Hits of the same rank are sorted by this.
  order: number;
}

// One document to index. sections are the sections extracted by document analysis.
export interface IndexedDocument extends IndexedMeta {
  sections: Section[];
}

export interface IndexQuery {
  query: string;
  mode: SearchMode;
  // Document IDs to restrict to. null means every document in the index.
  documents: ReadonlySet<string> | null;
}

// A ranked hit. The caller decides the offset and how many to return.
export type RankedHit = SearchHit;

// Max body/heading length per index entry (UTF-16 code units). Longer text is split into overlapping parts.
// Keeps each indexing step small so searches are not kept waiting while the index is built.
export const PART_LENGTH = 16_384;
// Overlap between parts. Well above the query limit (512 code points), so no literal match is missed.
export const PART_OVERLAP = 4_096;
// Terms in ancestor headings count as matches of descendant sections with the body weight (1 against the heading weight of 4).
const CONTEXT_FACTOR = 0.25;

// Section shape. Does not hold the heading text (the heading is assembled from the parts).
// Ancestor headings are followed by the parent section index (not duplicated per descendant section).
export interface IndexSection {
  sectionId: string;
  level: number;
  // Index of the parent heading section. null for the preamble and top-level headings.
  parent: number | null;
}

// Unit of indexing. A long section becomes one entry per overlapping part of its heading and body.
// section is set only on the first part of the section (part 0).
export interface IndexPart {
  sectionIndex: number;
  // Position of this part within the section.
  part: number;
  section: IndexSection | null;
  // The piece of the heading in this part, and the offset in the heading where it starts.
  heading: string;
  headingStart: number;
  body: string;
}

interface StoredSection extends IndexSection {
  // Full heading text assembled from the parts.
  title: string;
}

interface Entry {
  id: string;
  documentId: string;
  sectionIndex: number;
  part: number;
  // Fields passed to MiniSearch. title and path are document attributes, so they are set only on the first part of the first section
  // (setting them on every section would make all sections candidates for title terms).
  title: string;
  path: string;
  heading: string;
  body: string;
  // Normalized values for checking literal matches.
  normalizedBody: string;
  normalizedHeading: string;
}

interface Stored {
  meta: IndexedMeta;
  entries: Entry[];
  // Shape and first entry of each section, by section index.
  sections: Map<number, StoredSection>;
  heads: Map<number, Entry>;
  normalizedTitle: string;
  // Normalized paths and file name. Used for path search and exact-match checks.
  normalizedPaths: string[];
  normalizedName: string;
}

type MatchKind = SearchHit['matchKind'];

// Strength of each match kind. Lower ranks higher (spec 9.2).
const MATCH_RANK: Record<MatchKind, number> = {
  'path-exact': 0,
  phrase: 1,
  text: 2,
  prefix: 3,
  fuzzy: 4,
};

const BOOST = { title: 5, heading: 4, path: 3, body: 1 };
const EXCERPT_LEAD = 60;
// A query of ASCII letters, digits, and symbols only. Detected so a truncated word (such as `toke`) is not treated as a literal match.
const ASCII_ONLY = /^[ -~]+$/;
// Minimum length for prefix matching. A one-character prefix matches too many unrelated terms.
const PREFIX_MIN_LENGTH = 2;
// Number of character differences allowed as a spelling variation.
const FUZZY_DISTANCE = 1;

function pathsOf(meta: IndexedMeta): string[] {
  return [meta.displayPath, meta.canonicalPath].filter((path): path is string => path !== null);
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

// Splits long text into overlapping parts with their start offsets. Never splits inside a surrogate pair.
function splitWithStarts(text: string): Array<{ text: string; start: number }> {
  if (text.length <= PART_LENGTH) return [{ text, start: 0 }];
  const parts: Array<{ text: string; start: number }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + PART_LENGTH);
    if (end < text.length && isLowSurrogate(text, end)) end -= 1;
    parts.push({ text: text.slice(start, end), start });
    if (end >= text.length) break;
    let next = end - PART_OVERLAP;
    if (isLowSurrogate(text, next)) next -= 1;
    start = next;
  }
  return parts;
}

// Splits long text into overlapping parts.
export function splitParts(text: string): string[] {
  return splitWithStarts(text).map((part) => part.text);
}

export function partsOf(sections: Section[]): IndexPart[] {
  const parts: IndexPart[] = [];
  // Heading hierarchy. Follows the same rule as headingPath in analysis (closes headings at the same or deeper level).
  const stack: Array<{ index: number; level: number }> = [];
  for (const [sectionIndex, section] of sections.entries()) {
    let parent: number | null = null;
    if (section.level > 0) {
      while (stack.length > 0 && (stack.at(-1) as { level: number }).level >= section.level) {
        stack.pop();
      }
      parent = stack.at(-1)?.index ?? null;
      stack.push({ index: sectionIndex, level: section.level });
    }
    const headings = splitWithStarts(section.title);
    const bodies = splitParts(section.text);
    for (let part = 0; part < Math.max(headings.length, bodies.length); part += 1) {
      parts.push({
        sectionIndex,
        part,
        section: part === 0 ? { sectionId: section.sectionId, level: section.level, parent } : null,
        heading: headings[part]?.text ?? '',
        headingStart: headings[part]?.start ?? 0,
        body: bodies[part] ?? '',
      });
    }
  }
  return parts;
}

// Approximate cost of indexing a part: the total length of the indexed fields.
export function partWeight(part: IndexPart): number {
  return part.heading.length + part.body.length;
}

// Splits parts into batches by the per-step indexing limit. A batch is cut before exceeding the limit,
// so a batch exceeds it only when a single part does (up to the combined length of a split heading and body).
export function batchesOf(parts: IndexPart[], maxWeight: number, maxParts: number): IndexPart[][] {
  const batches: IndexPart[][] = [];
  let batch: IndexPart[] = [];
  let weight = 0;
  for (const part of parts) {
    const next = partWeight(part);
    if (batch.length > 0 && (weight + next > maxWeight || batch.length >= maxParts)) {
      batches.push(batch);
      batch = [];
      weight = 0;
    }
    batch.push(part);
    weight += next;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// Extracts the text around the match position from the extracted body. No summarizing or rephrasing (spec 9.4).
function excerptOf(text: string, normalized: string, needles: string[]): string {
  let at = -1;
  for (const needle of needles) {
    if (needle.trim() === '') continue;
    at = normalized.indexOf(needle);
    if (at !== -1) break;
  }
  // Normalization can change the length, so the position is mapped to the original text proportionally.
  const position = at <= 0 ? 0 : Math.floor((at * text.length) / Math.max(1, normalized.length));
  let start = Math.max(0, position - EXCERPT_LEAD);
  // Never start inside a surrogate pair.
  if (start > 0 && isLowSurrogate(text, start)) start -= 1;
  const window = text.slice(start, start + LIMITS.searchExcerptCodePoints * 2 + EXCERPT_LEAD);
  return sliceCodePoints(window, 0, LIMITS.searchExcerptCodePoints).replace(/\s+/g, ' ').trim();
}

const sectionKeyOf = (entry: Entry) => `${entry.documentId}\n${String(entry.sectionIndex)}`;

// Whether any matched term was found in the body field (MiniSearch's match: term -> fields).
function matchedInBody(match: Record<string, string[]>): boolean {
  for (const term in match) {
    if (match[term]?.includes('body') === true) return true;
  }
  return false;
}

// Term matches aggregated per section.
interface SectionMatch {
  stored: Stored;
  sectionIndex: number;
  score: number;
  // The highest scoring part, and the part matched in the body (used for the excerpt). null for sections matched only via ancestor headings.
  entry: Entry | null;
  entryScore: number;
  bodyEntry: Entry | null;
  bodyScore: number;
}

function emptyMatch(stored: Stored, sectionIndex: number): SectionMatch {
  return {
    stored,
    sectionIndex,
    score: 0,
    entry: null,
    entryScore: 0,
    bodyEntry: null,
    bodyScore: 0,
  };
}

// Per-section search index of open documents.
// Term matches use MiniSearch; literal matches use substring search on the normalized body.
//
// A document is added as "begin, append in several steps, commit". It is not searchable until committed,
// and on commit it replaces the previous revision. This lets search requests interleave with appends.
// Long sections are split into several entries, but matching and results are per section.
export class SearchIndex {
  // Committed documents. Only these are searched.
  readonly #documents = new Map<string, Stored>();
  // Documents being added.
  readonly #staging = new Map<string, Stored>();
  readonly #entries = new Map<string, { stored: Stored; entry: Entry }>();
  // Index generation. Advanced each time a document begins, and included in entry IDs (never confused with entries of a previous revision).
  #generation = 0;
  readonly #mini = new MiniSearch<Entry>({
    idField: 'id',
    fields: ['title', 'path', 'heading', 'body'],
    // Tokenization and normalization follow our own rules, not just whitespace splitting.
    tokenize: (text) => tokenize(text),
    processTerm: (term) => term,
  });

  get size(): number {
    return this.#documents.size;
  }

  // Counts of retained entries (used to check for resource leaks; daemon.diagnostics).
  // With settle, counts after cleaning up discarded entries (MiniSearch vacuum).
  async retainedCounts(settle: boolean): Promise<Record<string, number>> {
    if (settle) await this.#mini.vacuum();
    return {
      documents: this.#documents.size,
      staging: this.#staging.size,
      entries: this.#entries.size,
      miniDocuments: this.#mini.documentCount,
      miniTerms: this.#mini.termCount,
      miniDirt: this.#mini.dirtCount,
    };
  }

  get generation(): number {
    return this.#generation;
  }

  revisionOf(documentId: string): string | null {
    return this.#documents.get(documentId)?.meta.revision ?? null;
  }

  #discard(stored: Stored | undefined): void {
    if (!stored) return;
    for (const entry of stored.entries) {
      this.#mini.discard(entry.id);
      this.#entries.delete(entry.id);
    }
  }

  #stored(
    meta: IndexedMeta,
    entries: Entry[],
    sections: Map<number, StoredSection>,
    heads: Map<number, Entry>,
  ): Stored {
    return {
      meta,
      entries,
      sections,
      heads,
      normalizedTitle: normalizeForSearch(meta.title),
      normalizedPaths: pathsOf(meta).map(normalizeForSearch),
      normalizedName: meta.fileName === null ? '' : normalizeForSearch(meta.fileName),
    };
  }

  remove(documentId: string): void {
    this.abort(documentId);
    this.#discard(this.#documents.get(documentId));
    this.#documents.delete(documentId);
    this.#generation += 1;
  }

  // Discards a document being added. The committed document remains.
  abort(documentId: string): void {
    this.#discard(this.#staging.get(documentId));
    this.#staging.delete(documentId);
  }

  begin(meta: IndexedMeta): void {
    this.abort(meta.documentId);
    this.#generation += 1;
    this.#staging.set(meta.documentId, this.#stored({ ...meta }, [], new Map(), new Map()));
  }

  // Appends section parts. The caller may pass the parts from partsOf in several calls.
  append(documentId: string, revision: string, parts: IndexPart[]): void {
    const stored = this.#staging.get(documentId);
    if (!stored || stored.meta.revision !== revision) {
      throw new Error('The section belongs to a document that has not begun.');
    }
    const { meta } = stored;
    const entries = parts.map((item): Entry => {
      if (item.section) stored.sections.set(item.sectionIndex, { ...item.section, title: '' });
      const section = stored.sections.get(item.sectionIndex);
      if (!section) throw new Error('The first part of the section is missing.');
      // Assembles the overlapping heading parts back into the full text (parts arrive in order).
      if (item.heading !== '') {
        section.title += item.heading.slice(section.title.length - item.headingStart);
      }
      const head = item.sectionIndex === 0 && item.part === 0;
      return {
        id: `${documentId}:${String(this.#generation)}:${String(item.sectionIndex)}:${String(item.part)}`,
        documentId,
        sectionIndex: item.sectionIndex,
        part: item.part,
        title: head ? meta.title : '',
        path: head ? pathsOf(meta).join(' ') : '',
        heading: item.heading,
        body: item.body,
        normalizedBody: normalizeForSearch(item.body),
        normalizedHeading: normalizeForSearch(item.heading),
      };
    });
    this.#mini.addAll(entries);
    for (const entry of entries) {
      stored.entries.push(entry);
      if (entry.part === 0) stored.heads.set(entry.sectionIndex, entry);
      this.#entries.set(entry.id, { stored, entry });
    }
  }

  // Commits a fully added document, replacing the previous revision.
  commit(documentId: string, revision: string): void {
    const stored = this.#staging.get(documentId);
    if (!stored || stored.meta.revision !== revision) {
      throw new Error('The document has not begun.');
    }
    this.#staging.delete(documentId);
    this.#discard(this.#documents.get(documentId));
    this.#documents.set(documentId, stored);
    this.#generation += 1;
  }

  // Adds a document in one step (convenience for tests and small documents).
  upsert(document: IndexedDocument): void {
    const { sections, ...meta } = document;
    this.begin(meta);
    this.append(meta.documentId, meta.revision, partsOf(sections));
    this.commit(meta.documentId, meta.revision);
  }

  // Changes only title, path, and order without re-indexing the content. Returns false if the revision differs (re-indexing needed).
  updateMeta(meta: IndexedMeta): boolean {
    const current = this.#documents.get(meta.documentId);
    if (!current || current.meta.revision !== meta.revision) return false;
    const next = this.#stored({ ...meta }, current.entries, current.sections, current.heads);
    const head = current.heads.get(0);
    if (
      head &&
      (current.meta.title !== meta.title ||
        next.normalizedPaths.join('\n') !== current.normalizedPaths.join('\n'))
    ) {
      const replaced: Entry = { ...head, title: meta.title, path: pathsOf(meta).join(' ') };
      this.#mini.replace(replaced);
      next.entries = current.entries.map((entry) => (entry === head ? replaced : entry));
      next.heads = new Map(current.heads);
      next.heads.set(0, replaced);
    }
    for (const entry of next.entries) this.#entries.set(entry.id, { stored: next, entry });
    this.#documents.set(meta.documentId, next);
    this.#generation += 1;
    return true;
  }

  // Headings from the top-level ancestor down. Followed by parent section index.
  #headingPathOf(stored: Stored, sectionIndex: number): string[] {
    const path: string[] = [];
    let current = stored.sections.get(sectionIndex);
    if (!current || current.level === 0) return path;
    while (current) {
      path.unshift(current.title);
      current = current.parent === null ? undefined : stored.sections.get(current.parent);
    }
    return path;
  }

  // Indexes of sections under a heading section: following sections in document order while headings are deeper.
  #descendantsOf(stored: Stored, sectionIndex: number): number[] {
    const own = stored.sections.get(sectionIndex);
    if (!own || own.level === 0) return [];
    const children: number[] = [];
    for (let index = sectionIndex + 1; ; index += 1) {
      const next = stored.sections.get(index);
      if (!next || next.level <= own.level) break;
      children.push(index);
    }
    return children;
  }

  // Returns matched sections in rank order. At most 2 per document (spec 9.2).
  search(input: IndexQuery): RankedHit[] {
    // The query as given. exact and path match it verbatim, whitespace included.
    const verbatim = normalizeForSearch(input.query);
    if (verbatim.trim() === '') return [];
    // For text search, whitespace is normalized so word separators do not matter.
    const query = input.mode === 'text' ? verbatim.replace(/\s+/g, ' ').trim() : verbatim;
    const terms = uniqueTokens(input.query);
    const included = (documentId: string) =>
      input.documents === null || input.documents.has(documentId);
    // Only entries of committed documents are used. Entries being added are not returned even if MiniSearch has them.
    const usable = (stored: Stored) =>
      this.#documents.get(stored.meta.documentId) === stored && included(stored.meta.documentId);

    // Candidates are per section. entry is the part used for the excerpt. inBody is whether that part matched in the body.
    interface Candidate {
      stored: Stored;
      entry: Entry;
      inBody: boolean;
      kind: MatchKind;
      score: number;
    }
    const candidates = new Map<string, Candidate>();
    const offer = (
      stored: Stored,
      entry: Entry,
      kind: MatchKind,
      score: number,
      inBody: boolean,
    ) => {
      const key = sectionKeyOf(entry);
      const existing = candidates.get(key);
      if (!existing) {
        candidates.set(key, { stored, entry, inBody, kind, score });
        return;
      }
      // Take the stronger match kind and keep the higher score.
      if (MATCH_RANK[kind] < MATCH_RANK[existing.kind]) existing.kind = kind;
      existing.score = Math.max(existing.score, score);
      // The excerpt part is chosen independently of the match kind. A body match is never replaced by a heading-only match.
      if (inBody && !existing.inBody) {
        existing.entry = entry;
        existing.inBody = true;
      }
    };

    if (input.mode === 'text' && terms.length > 0) {
      // Only sections where every term appears (in the section or its ancestor headings). Terms are never dropped to turn it into another search.
      // Long sections are split, so matching parts are looked up per term and aggregated per section.
      // Terms in ancestor headings count as matches of descendant sections (ancestor headings are not duplicated per section).
      const restricted = input.documents !== null || this.#staging.size > 0;
      const run = (kind: MatchKind, options: { prefix: boolean; fuzzy: boolean }) => {
        // Sections found by a stronger search are discarded from this one (see the end of run), and entries outside
        // the searched documents are skipped below. Excluding them inside MiniSearch keeps it from building result
        // objects for them, which is most of the garbage of a search that matches many sections.
        // A document boost of 0 skips the entry before scoring; other entries' scores do not change.
        const decided = new Map<Stored, Set<number>>();
        for (const candidate of candidates.values()) {
          const sections = decided.get(candidate.stored) ?? new Set<number>();
          sections.add(candidate.entry.sectionIndex);
          decided.set(candidate.stored, sections);
        }
        const boostDocument =
          restricted || decided.size > 0
            ? (id: string) => {
                const found = this.#entries.get(id);
                if (!found || !usable(found.stored)) return 0;
                return decided.get(found.stored)?.has(found.entry.sectionIndex) === true ? 0 : 1;
              }
            : undefined;
        let matched: Map<string, SectionMatch> | null = null;
        for (const term of terms) {
          const results = this.#mini.search(term, {
            boost: BOOST,
            ...(boostDocument ? { boostDocument } : {}),
            prefix: options.prefix ? (candidate) => candidate.length >= PREFIX_MIN_LENGTH : false,
            // At most one character difference, regardless of term length.
            fuzzy: options.fuzzy
              ? (candidate) => (allowsFuzzy(candidate) ? FUZZY_DISTANCE : false)
              : false,
            tokenize: (text) => [text],
            processTerm: (value) => value,
          });
          // Sections matched by this term. Remember the highest scoring part and the body-matched part per section.
          const satisfied = new Map<string, SectionMatch>();
          for (const result of results) {
            const found = this.#entries.get(String(result.id));
            if (!found || !usable(found.stored)) continue;
            const { stored, entry } = found;
            const key = sectionKeyOf(entry);
            const current = satisfied.get(key) ?? emptyMatch(stored, entry.sectionIndex);
            current.score = Math.max(current.score, result.score);
            if (result.score > current.entryScore) {
              current.entry = entry;
              current.entryScore = result.score;
            }
            if (result.score > current.bodyScore && matchedInBody(result.match)) {
              current.bodyEntry = entry;
              current.bodyScore = result.score;
            }
            satisfied.set(key, current);
          }
          // Also count matches for descendants of sections whose heading matched. Only the heading field score is inherited
          // (matches on the parent's title, path, or body do not count for descendants).
          const headings = this.#mini.search(term, {
            fields: ['heading'],
            boost: { heading: BOOST.heading },
            prefix: options.prefix ? (candidate) => candidate.length >= PREFIX_MIN_LENGTH : false,
            fuzzy: options.fuzzy
              ? (candidate) => (allowsFuzzy(candidate) ? FUZZY_DISTANCE : false)
              : false,
            tokenize: (text) => [text],
            processTerm: (value) => value,
          });
          for (const result of headings) {
            const found = this.#entries.get(String(result.id));
            if (!found || !usable(found.stored)) continue;
            const { stored, entry } = found;
            for (const child of this.#descendantsOf(stored, entry.sectionIndex)) {
              const key = `${stored.meta.documentId}\n${String(child)}`;
              const current = satisfied.get(key) ?? emptyMatch(stored, child);
              current.score = Math.max(current.score, result.score * CONTEXT_FACTOR);
              satisfied.set(key, current);
            }
          }
          if (matched === null) {
            matched = satisfied;
          } else {
            for (const [key, value] of matched) {
              const found = satisfied.get(key);
              if (!found) {
                matched.delete(key);
                continue;
              }
              value.score += found.score;
              if (found.entry && found.entryScore > value.entryScore) {
                value.entry = found.entry;
                value.entryScore = found.entryScore;
              }
              if (found.bodyEntry && found.bodyScore > value.bodyScore) {
                value.bodyEntry = found.bodyEntry;
                value.bodyScore = found.bodyScore;
              }
            }
          }
          // Stop once no section can match every term. Sections found by a stronger stage also match in this one
          // (a weaker stage matches more), so while there are any, every term is still looked up even if they are
          // excluded above. MiniSearch drops postings of replaced and removed entries while it looks up a term,
          // and those still count in scores until then, so skipping lookups would change later scores.
          if (matched.size === 0 && decided.size === 0) return;
        }
        for (const [key, value] of matched ?? []) {
          // A weaker search does not overwrite sections found by a stronger one.
          if (candidates.has(key)) continue;
          // Prefer the body-matched part for the excerpt.
          const entry =
            value.bodyEntry ?? value.entry ?? value.stored.heads.get(value.sectionIndex);
          if (entry) offer(value.stored, entry, kind, value.score, value.bodyEntry !== null);
        }
      };
      // A stage whose options apply to no term repeats the lookups of the stage before it. It still runs:
      // MiniSearch drops postings of replaced and removed entries while it walks the terms, and a walk can leave
      // some of them for the next one, so skipping it would change later scores until the index is cleaned up.
      run('text', { prefix: false, fuzzy: false });
      run('prefix', { prefix: true, fuzzy: false });
      run('fuzzy', { prefix: true, fuzzy: true });
    }

    // Exact file name or path matches are checked against both the verbatim and the whitespace-normalized query.
    const exactNames = new Set([verbatim, query]);
    for (const stored of this.#documents.values()) {
      if (!included(stored.meta.documentId)) continue;
      const first = stored.entries[0];
      if (!first) continue;
      // Documents whose file name or path exactly equals the query.
      const pathExact =
        exactNames.has(stored.normalizedName) ||
        stored.normalizedPaths.some((path) => exactNames.has(path));
      if (pathExact) offer(stored, first, 'path-exact', 0, false);
      if (input.mode === 'path') {
        // Path search looks only at file names and paths, not the body.
        if (!pathExact && stored.normalizedPaths.some((path) => path.includes(query))) {
          offer(stored, first, 'phrase', 0, false);
        }
        continue;
      }
      // Sections where the query appears verbatim as a literal string.
      // Ranked above sections where the terms appear scattered (text). The score from the term match is used as is.
      const titleOrPath =
        stored.normalizedTitle.includes(query) ||
        stored.normalizedPaths.some((path) => path.includes(query));
      for (const entry of stored.entries) {
        const inBody = entry.normalizedBody.includes(query);
        const literal =
          inBody || entry.normalizedHeading.includes(query) || (titleOrPath && entry === first);
        if (!literal) continue;
        const known = candidates.get(sectionKeyOf(entry));
        if (input.mode === 'exact' || known?.kind === 'text') {
          offer(stored, entry, 'phrase', 0, inBody);
        } else if (!ASCII_ONLY.test(query)) {
          // Literal strings that tokenization misses, such as Japanese.
          offer(stored, entry, 'phrase', 0, inBody);
        } else if (!known && codePointLength(query) >= PREFIX_MIN_LENGTH) {
          // A truncated ASCII word. It does not match as a term, so treat it like a prefix match.
          // Like prefix matching, not used for a single character.
          offer(stored, entry, 'prefix', 0, inBody);
        }
      }
    }
    // Searches that require literal matches do not return candidates matched only by terms.
    const ranked = [...candidates.values()]
      .filter(
        (candidate) =>
          input.mode === 'text' || candidate.kind === 'phrase' || candidate.kind === 'path-exact',
      )
      .toSorted(
        (a, b) =>
          MATCH_RANK[a.kind] - MATCH_RANK[b.kind] ||
          b.score - a.score ||
          a.stored.meta.order - b.stored.meta.order ||
          a.entry.sectionIndex - b.entry.sectionIndex,
      );

    const perDocument = new Map<string, number>();
    const hits: RankedHit[] = [];
    for (const { stored, entry, kind, score } of ranked) {
      const { meta } = stored;
      const count = perDocument.get(meta.documentId) ?? 0;
      if (count >= LIMITS.searchHitsPerDocument) continue;
      const shape = stored.sections.get(entry.sectionIndex);
      if (!shape) continue;
      perDocument.set(meta.documentId, count + 1);
      // The normalized text is kept for literal matches; only the title fallbacks are normalized here.
      let body = entry.body;
      let normalized = entry.normalizedBody;
      if (body === '') {
        body = entry.heading;
        normalized = entry.normalizedHeading;
      }
      if (body === '') {
        body = shape.title || meta.title;
        normalized = normalizeForSearch(body);
      }
      hits.push({
        documentId: meta.documentId,
        revision: meta.revision,
        title: meta.title,
        displayPath: meta.displayPath,
        sectionId: shape.sectionId,
        headingPath: this.#headingPathOf(stored, entry.sectionIndex),
        excerpt: excerptOf(body, normalized, [query, ...terms]),
        matchKind: kind,
        score: Math.round(score * 1000) / 1000,
        // Analysis has no source positions, so guessed line numbers are not returned (spec 8.3).
        sourceRange: null,
        extraction: meta.format === 'markdown' ? 'markdown' : 'static-html',
      });
    }
    return hits;
  }
}
