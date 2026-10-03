// @vitest-environment happy-dom
import type { SearchHit, SearchResult } from '@vde-open/shared';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Api } from '@/lib/api';

import { SearchDialog } from './search-dialog.tsx';

const REV1 = `rev_${'1'.repeat(64)}`;

function hitOf(index: number): SearchHit {
  return {
    documentId: 'doc_1',
    revision: REV1,
    title: '文書',
    displayPath: 'a.md',
    sectionId: `sec_${String(index).padStart(4, '0')}`,
    headingPath: [`見出し${String(index)}`],
    excerpt: `抜粋${String(index)}`,
    matchKind: 'text',
    score: 1,
    sourceRange: null,
    extraction: 'markdown',
  };
}

let container: HTMLElement;
let root: Root;
// 検索の応答を、試験の側で返す。
let pending: Array<(result: SearchResult) => void>;
let selected: SearchHit[];
let scrolled: string[];
let api: Api;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  pending = [];
  selected = [];
  scrolled = [];
  api = {
    search: () => new Promise<SearchResult>((resolve) => pending.push(resolve)),
  } as unknown as Api;
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
    this: HTMLElement,
  ) {
    scrolled.push(this.id);
  });
  root.render(
    <SearchDialog
      api={api}
      open
      onOpenChange={() => undefined}
      onSelect={(hit) => selected.push(hit)}
    />,
  );
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.restoreAllMocks();
});

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await settle(10);
}
function input(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>('input[aria-label="検索する語句"]');
  if (!found) throw new Error('検索の入力欄が見つかりません');
  return found;
}
function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input(), value);
  input().dispatchEvent(new Event('input', { bubbles: true }));
}
function press(key: string, isComposing = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true });
  input().dispatchEvent(event);
  return event;
}
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const activeIndex = () =>
  options().findIndex((option) => option.getAttribute('aria-selected') === 'true');
// 入力から検索の依頼までの待ち（200ms）を過ぎ、依頼が届くのを待って応答する。
async function respond(count: number): Promise<void> {
  await until(() => pending.length > 0);
  pending.shift()?.({
    hits: Array.from({ length: count }, (_, index) => hitOf(index)),
  } as SearchResult);
  await until(() => options().length === count);
}

describe('UX-002 検索の結果のkeyboard操作', () => {
  it('変換中の↑↓とEnterは入力欄へ渡し、選択も移動もしない', async () => {
    await until(() => document.querySelector('input') !== null);
    type('検索');
    await respond(3);
    expect(press('ArrowDown', true).defaultPrevented).toBe(false);
    expect(press('ArrowUp', true).defaultPrevented).toBe(false);
    expect(press('Enter', true).defaultPrevented).toBe(false);
    await settle();
    expect(activeIndex()).toBe(0);
    expect(selected).toEqual([]);
    // 変換を終えた後の↓は、結果を選ぶ。
    expect(press('ArrowDown').defaultPrevented).toBe(true);
    await until(() => activeIndex() === 1);
    expect(activeIndex()).toBe(1);
  });

  it('結果を待っている間の↓で選択を失わず、届いた結果の先頭をEnterで開ける', async () => {
    await until(() => document.querySelector('input') !== null);
    type('検索');
    // 検索の依頼（入力から200ms後）より前に、画面の更新を挟んで↓を押す。
    await settle(20);
    press('ArrowDown');
    await settle(20);
    press('ArrowDown');
    expect(pending).toHaveLength(0);
    await respond(3);
    expect(activeIndex()).toBe(0);
    press('Enter');
    await until(() => selected.length > 0);
    expect(selected.map((hit) => hit.sectionId)).toEqual(['sec_0000']);
  });

  it('下へ移動すると、選んだ行を見える位置へscrollし、末尾で止まる', async () => {
    await until(() => document.querySelector('input') !== null);
    type('検索');
    await respond(20);
    for (let index = 0; index < 25; index += 1) press('ArrowDown');
    await until(() => activeIndex() === 19);
    expect(activeIndex()).toBe(19);
    expect(scrolled.at(-1)).toBe(options()[19]?.id);
    for (let index = 0; index < 25; index += 1) press('ArrowUp');
    await until(() => activeIndex() === 0);
    expect(scrolled.at(-1)).toBe(options()[0]?.id);
  });
});
