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

// 文書の属性。本文を入れ直さずに変えられる。
export interface IndexedMeta {
  documentId: string;
  revision: string;
  format: DocumentFormat;
  title: string;
  displayPath: string | null;
  // file名と、symlinkを解決した絶対path。stdinの文書はnull。
  fileName: string | null;
  canonicalPath: string | null;
  // 一覧での順番。同じ順位のhitを、この順で並べる。
  order: number;
}

// indexへ入れる1文書。sectionsは、文書の解析で取り出した節。
export interface IndexedDocument extends IndexedMeta {
  sections: Section[];
}

export interface IndexQuery {
  query: string;
  mode: SearchMode;
  // 対象を絞る文書ID。nullなら、indexにある文書のすべて。
  documents: ReadonlySet<string> | null;
}

// 順位を付けた後のhit。何件目から何件返すかは、呼び出し側が決める。
export type RankedHit = SearchHit;

// 1つの索引項目に入れる本文・見出しの上限（UTF-16のcode unit）。長いものは、重ねながら分ける。
// 1回に索引へ入れる量を小さくして、索引を作っている間も検索を待たせ続けないようにする。
export const PART_LENGTH = 16_384;
// 分けた部分の重なり。queryの上限（512 code point）を十分に含むので、連続した文字列の一致を取りこぼさない。
export const PART_OVERLAP = 4_096;
// 上位の見出しの語は、配下の節の一致として、本文と同じ重み（見出しの重み4に対して1）で数える。
const CONTEXT_FACTOR = 0.25;

// 節の形。見出しの文字列は持たない（見出しは分けた部分から組み立てる）。
// 上位の見出しは、親の節の番号でたどる（配下の節ごとに上位の見出しを複製しない）。
export interface IndexSection {
  sectionId: string;
  level: number;
  // 親の見出しの節の番号。序文と最上位の見出しはnull。
  parent: number | null;
}

// 索引へ入れる単位。長い節は、見出しと本文を重ねながら分けた部分ごとに1件。
// sectionは、節の先頭の部分（part 0）にだけ入れる。
export interface IndexPart {
  sectionIndex: number;
  // 節の中で何番目の部分か。
  part: number;
  section: IndexSection | null;
  // この部分が持つ、見出しの一部と、それが見出しの何文字目から始まるか。
  heading: string;
  headingStart: number;
  body: string;
}

interface StoredSection extends IndexSection {
  // 分けた部分から組み立てた、見出しの全文。
  title: string;
}

interface Entry {
  id: string;
  documentId: string;
  sectionIndex: number;
  part: number;
  // MiniSearchへ渡すfield。titleとpathは文書の属性なので、先頭の節の先頭の部分にだけ入れる
  // （全部の節に入れると、titleの語で、文書のすべての節が候補になる）。
  title: string;
  path: string;
  heading: string;
  body: string;
  // 連続した文字列の一致を調べるための、正規化した値。
  normalizedBody: string;
  normalizedHeading: string;
}

interface Stored {
  meta: IndexedMeta;
  entries: Entry[];
  // 節の番号ごとの形と、節の先頭の項目。
  sections: Map<number, StoredSection>;
  heads: Map<number, Entry>;
  normalizedTitle: string;
  // 正規化したpathとfile名。pathの検索と、完全一致の判定に使う。
  normalizedPaths: string[];
  normalizedName: string;
}

type MatchKind = SearchHit['matchKind'];

// 一致の種類の強さ。小さいほど上位（仕様9.2）。
const MATCH_RANK: Record<MatchKind, number> = {
  'path-exact': 0,
  phrase: 1,
  text: 2,
  prefix: 3,
  fuzzy: 4,
};

const BOOST = { title: 5, heading: 4, path: 3, body: 1 };
const EXCERPT_LEAD = 60;
// 英数と記号だけのquery。語の途中で切った文字列（`toke`など）を、連続した一致として扱わないために見分ける。
const ASCII_ONLY = /^[ -~]+$/;
// 前方一致を使う最小の長さ。1文字の前方一致は、関係のない語に広く当たる。
const PREFIX_MIN_LENGTH = 2;
// 綴りのゆらぎとして許す、文字の違いの数。
const FUZZY_DISTANCE = 1;

function pathsOf(meta: IndexedMeta): string[] {
  return [meta.displayPath, meta.canonicalPath].filter((path): path is string => path !== null);
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

// 長い文字列を、重ねながら分けた部分と、それぞれの開始位置。surrogate pairの途中では切らない。
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

// 長い文字列を、重ねながら分ける。
export function splitParts(text: string): string[] {
  return splitWithStarts(text).map((part) => part.text);
}

export function partsOf(sections: Section[]): IndexPart[] {
  const parts: IndexPart[] = [];
  // 見出しの親子。解析のheadingPathと同じ規則（自分以上の深さの見出しを閉じる）でたどる。
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

// 部分を索引へ入れるときの処理量の目安。索引に入れるfieldの長さの合計。
export function partWeight(part: IndexPart): number {
  return part.heading.length + part.body.length;
}

// 部分を、1回に索引へ入れる量の上限で区切る。上限を超える前に区切るので、
// 1回分が上限を超えるのは、1つの部分だけで上限を超えるとき（見出しと本文の分けた長さの合計まで）だけ。
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

// 抽出した本文から、一致した位置の周りを抜き出す。要約や言い換えはしない（仕様9.4）。
function excerptOf(text: string, normalized: string, needles: string[]): string {
  let at = -1;
  for (const needle of needles) {
    if (needle.trim() === '') continue;
    at = normalized.indexOf(needle);
    if (at !== -1) break;
  }
  // 正規化で長さが変わることがあるので、位置は比率で元の本文へ写す。
  const position = at <= 0 ? 0 : Math.floor((at * text.length) / Math.max(1, normalized.length));
  let start = Math.max(0, position - EXCERPT_LEAD);
  // surrogate pairの途中から始めない。
  if (start > 0 && isLowSurrogate(text, start)) start -= 1;
  const window = text.slice(start, start + LIMITS.searchExcerptCodePoints * 2 + EXCERPT_LEAD);
  return sliceCodePoints(window, 0, LIMITS.searchExcerptCodePoints).replace(/\s+/g, ' ').trim();
}

const sectionKeyOf = (entry: Entry) => `${entry.documentId}\n${String(entry.sectionIndex)}`;

// 語の一致を、節の単位でまとめたもの。
interface SectionMatch {
  stored: Stored;
  sectionIndex: number;
  score: number;
  // 最もscoreの高い部分と、本文に一致した部分（抜粋に使う）。上位の見出しだけで一致した節はnull。
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

// 開いている文書の、節ごとの検索index。
// 語の一致はMiniSearchで、連続した文字列の一致は正規化した本文への部分一致で調べる。
//
// 文書は「始める→何回かに分けて入れる→確定する」の順に入れる。確定するまでは検索に出さず、
// 確定した時点で、前の版と入れ替える。分けて入れる間に、検索の依頼を挟めるようにするため。
// 長い節は複数の項目に分けて入れるが、一致の判定と結果は節の単位で行う。
export class SearchIndex {
  // 確定した文書。検索の対象はこれだけ。
  readonly #documents = new Map<string, Stored>();
  // 入れている途中の文書。
  readonly #staging = new Map<string, Stored>();
  readonly #entries = new Map<string, { stored: Stored; entry: Entry }>();
  // 索引の世代。文書を入れ始めるたびに進め、索引項目のIDに含める（前の版の項目と取り違えない）。
  #generation = 0;
  readonly #mini = new MiniSearch<Entry>({
    idField: 'id',
    fields: ['title', 'path', 'heading', 'body'],
    // 語への分割と正規化は、自前の規則で行う。空白での分割だけには頼らない。
    tokenize: (text) => tokenize(text),
    processTerm: (term) => term,
  });

  get size(): number {
    return this.#documents.size;
  }

  // 保持している項目の数（資源の漏れの確認に使う。daemon.diagnostics）。
  // settleなら、消した項目の片付け（MiniSearchのvacuum）を終えてから数える。
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

  // 入れている途中の文書を捨てる。確定した文書は残す。
  abort(documentId: string): void {
    this.#discard(this.#staging.get(documentId));
    this.#staging.delete(documentId);
  }

  begin(meta: IndexedMeta): void {
    this.abort(meta.documentId);
    this.#generation += 1;
    this.#staging.set(meta.documentId, this.#stored({ ...meta }, [], new Map(), new Map()));
  }

  // 節の部分を入れる。呼び出し側は、partsOfで分けた部分を、何回かに分けて渡せる。
  append(documentId: string, revision: string, parts: IndexPart[]): void {
    const stored = this.#staging.get(documentId);
    if (!stored || stored.meta.revision !== revision) {
      throw new Error('入れ始めていない文書の節です。');
    }
    const { meta } = stored;
    const entries = parts.map((item): Entry => {
      if (item.section) stored.sections.set(item.sectionIndex, { ...item.section, title: '' });
      const section = stored.sections.get(item.sectionIndex);
      if (!section) throw new Error('節の先頭の部分がありません。');
      // 重ねて分けた見出しを、元の全文へ組み立てる（部分は順に届く）。
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

  // 入れ終えた文書を確定し、前の版と入れ替える。
  commit(documentId: string, revision: string): void {
    const stored = this.#staging.get(documentId);
    if (!stored || stored.meta.revision !== revision) {
      throw new Error('入れ始めていない文書です。');
    }
    this.#staging.delete(documentId);
    this.#discard(this.#documents.get(documentId));
    this.#documents.set(documentId, stored);
    this.#generation += 1;
  }

  // 1回で文書を入れる（testと、小さな文書の便宜）。
  upsert(document: IndexedDocument): void {
    const { sections, ...meta } = document;
    this.begin(meta);
    this.append(meta.documentId, meta.revision, partsOf(sections));
    this.commit(meta.documentId, meta.revision);
  }

  // title・path・順番だけを変える。本文は入れ直さない。版が違えばfalse（入れ直しが必要）。
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

  // 上位の見出しから順に並べた見出し。親の節の番号でたどる。
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

  // 見出しの節の配下にある節の番号。文書の順で、より深い見出しが続く間が配下。
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

  // 一致した節を、順位の順に返す。1文書から返すのは2件まで（仕様9.2）。
  search(input: IndexQuery): RankedHit[] {
    // 指定どおりの文字列。exactとpathは、空白も含めてこのまま照合する。
    const verbatim = normalizeForSearch(input.query);
    if (verbatim.trim() === '') return [];
    // textの検索では、語の区切りの違いを問わないよう、空白をそろえる。
    const query = input.mode === 'text' ? verbatim.replace(/\s+/g, ' ').trim() : verbatim;
    const terms = uniqueTokens(input.query);
    const included = (documentId: string) =>
      input.documents === null || input.documents.has(documentId);
    // 確定した文書の項目だけを使う。入れている途中の項目は、MiniSearchにあっても返さない。
    const usable = (stored: Stored) =>
      this.#documents.get(stored.meta.documentId) === stored && included(stored.meta.documentId);

    // 候補は節の単位で持つ。entryは、抜粋に使う部分。inBodyは、その部分の本文に一致があるか。
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
      // 強い種類の一致を採り、scoreは高いほうを残す。
      if (MATCH_RANK[kind] < MATCH_RANK[existing.kind]) existing.kind = kind;
      existing.score = Math.max(existing.score, score);
      // 抜粋に使う部分は、一致の種類とは別に選ぶ。本文に一致した部分を、見出しだけの一致で置き換えない。
      if (inBody && !existing.inBody) {
        existing.entry = entry;
        existing.inBody = true;
      }
    };

    if (input.mode === 'text' && terms.length > 0) {
      // 全部の検索語が、同じ節（とその上位の見出し）に現れるものだけ。語を勝手に減らして、別の検索へ変えない。
      // 長い節は分けて入れているので、語ごとに一致する部分を引き、節の単位でまとめて判定する。
      // 上位の見出しにある語は、配下の節の一致として数える（上位の見出しを節ごとに複製しない）。
      const run = (kind: MatchKind, options: { prefix: boolean; fuzzy: boolean }) => {
        let matched: Map<string, SectionMatch> | null = null;
        for (const term of terms) {
          const results = this.#mini.search(term, {
            boost: BOOST,
            prefix: options.prefix ? (candidate) => candidate.length >= PREFIX_MIN_LENGTH : false,
            // 文字の違いは1つまで。語の長さに比例させない。
            fuzzy: options.fuzzy
              ? (candidate) => (allowsFuzzy(candidate) ? FUZZY_DISTANCE : false)
              : false,
            tokenize: (text) => [text],
            processTerm: (value) => value,
          });
          // この語が一致した節。節の中で最もscoreの高い部分と、本文に一致した部分を覚える。
          const satisfied = new Map<string, SectionMatch>();
          for (const result of results) {
            const found = this.#entries.get(String(result.id));
            if (!found || !usable(found.stored)) continue;
            const { stored, entry } = found;
            const key = sectionKeyOf(entry);
            const fields = new Set(Object.values(result.match).flat());
            const current = satisfied.get(key) ?? emptyMatch(stored, entry.sectionIndex);
            current.score = Math.max(current.score, result.score);
            if (result.score > current.entryScore) {
              current.entry = entry;
              current.entryScore = result.score;
            }
            if (fields.has('body') && result.score > current.bodyScore) {
              current.bodyEntry = entry;
              current.bodyScore = result.score;
            }
            satisfied.set(key, current);
          }
          // 見出しに一致した節の配下の節にも、一致を数える。引き継ぐのは見出しのfieldだけのscore
          // （親の節のtitle・path・本文への一致は、配下の節の一致にしない）。
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
          if (matched.size === 0) return;
        }
        for (const [key, value] of matched ?? []) {
          // 弱い種類の検索は、強い種類で見つかった節を上書きしない。
          if (candidates.has(key)) continue;
          // 抜粋には、本文に一致した部分を優先して使う。
          const entry =
            value.bodyEntry ?? value.entry ?? value.stored.heads.get(value.sectionIndex);
          if (entry) offer(value.stored, entry, kind, value.score, value.bodyEntry !== null);
        }
      };
      run('text', { prefix: false, fuzzy: false });
      run('prefix', { prefix: true, fuzzy: false });
      run('fuzzy', { prefix: true, fuzzy: true });
    }

    // file名・pathの完全一致は、指定どおりの文字列と、空白をそろえた文字列のどちらでも見る。
    const exactNames = new Set([verbatim, query]);
    for (const stored of this.#documents.values()) {
      if (!included(stored.meta.documentId)) continue;
      const first = stored.entries[0];
      if (!first) continue;
      // file名またはpathが、queryと完全に一致する文書。
      const pathExact =
        exactNames.has(stored.normalizedName) ||
        stored.normalizedPaths.some((path) => exactNames.has(path));
      if (pathExact) offer(stored, first, 'path-exact', 0, false);
      if (input.mode === 'path') {
        // pathの検索は、file名とpathだけを対象にする。本文は見ない。
        if (!pathExact && stored.normalizedPaths.some((path) => path.includes(query))) {
          offer(stored, first, 'phrase', 0, false);
        }
        continue;
      }
      // queryが、連続した文字列としてそのまま現れる節。
      // 語がばらばらに現れるだけの節（text）より上に置く。重みは、語の一致で付いたscoreをそのまま使う。
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
          // 語への分割では取りこぼす、日本語などの連続した文字列。
          offer(stored, entry, 'phrase', 0, inBody);
        } else if (!known && codePointLength(query) >= PREFIX_MIN_LENGTH) {
          // 英数の語の途中までの文字列。語としては一致していないので、前方一致と同じ扱いにする。
          // 前方一致と同じく、1文字では使わない。
          offer(stored, entry, 'prefix', 0, inBody);
        }
      }
    }
    // 連続した文字列の一致だけを求める検索では、語の一致だけの候補は返さない。
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
      const body = entry.body !== '' ? entry.body : entry.heading || shape.title || meta.title;
      hits.push({
        documentId: meta.documentId,
        revision: meta.revision,
        title: meta.title,
        displayPath: meta.displayPath,
        sectionId: shape.sectionId,
        headingPath: this.#headingPathOf(stored, entry.sectionIndex),
        excerpt: excerptOf(body, normalizeForSearch(body), [query, ...terms]),
        matchKind: kind,
        score: Math.round(score * 1000) / 1000,
        // 解析結果に原文の位置がないので、推測した行番号は返さない（仕様8.3）。
        sourceRange: null,
        extraction: meta.format === 'markdown' ? 'markdown' : 'static-html',
      });
    }
    return hits;
  }
}
