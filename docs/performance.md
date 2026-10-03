# Performance measurements

[日本語](performance.ja.md)

Measurements against the performance goals in spec 16.1. The values are design goals, not promises. CI does not assert environment-dependent millisecond values; it checks for hangs, count limits, and resource growth (`tests/integration/resources.test.ts`).

## How it is measured

`pnpm build && pnpm perf` (`scripts/perf.ts`). The packaged build (`apps/cli/dist`) runs with a temporary `VDE_OPEN_HOME`. The fixtures are generated Markdown with fixed content (Japanese and English, a heading every 8 lines), with the given number of documents and total size.

- Cold open: from starting the daemon until every document in the directory is open (the CLI's `open docs --recursive`).
- Indexing: after opening, until every document is searchable.
- Warm search: p50 and p95 of 10 queries run 5 times each (50 runs) over IPC.
- List and read: listing every document (500 per page with a cursor) and reading one document.
- Update published: from rewriting a file until the revision in the IPC list changes (until the daemon publishes the new revision through the watcher).
- Management UI (Playwright's Chromium, headless, 1280×800):
  - List: from opening the one-time URL until every document is in the list (checked by the count heading and the number of rows).
  - Select: from clicking the last document in the list until its heading is shown.
  - Save to screen: from appending a line to the file of the shown document until that line appears on screen (in the DOM).
- Idle CPU: the share of CPU time the daemon process used during the first 5 seconds after the last operation. This includes the one garbage collection each thread runs after activity stops (see below).
- Memory of the daemon process (including the analysis and search worker threads). No garbage collection is forced; the values are what the daemon itself leaves.
  - Peak RSS: the largest RSS from connecting to the daemon until the last management UI operation (sampled every 200 ms with `ps`).
  - RSS 0, 5, 20, and 60 seconds after the last operation.
  - Physical footprint 60 seconds after the last operation (`vmmap --summary`, macOS only; what Activity Monitor shows as memory). RSS also counts code shared with other processes.
  - Used heap of each thread 60 seconds after the last operation (`daemon.diagnostics` without collection).
  - These are single measurements; whether memory keeps growing is not judged from them (see "Resource checks" below).

## Results (2026-10-04)

Environment: macOS (darwin arm64), Apple M5 Max (18 cores), Node.js v24.21.0, Chromium (Playwright 1.63.0, headless).

Daemon and IPC:

| fixture | documents | cold open | indexing | search p50 | search p95 | list | read | update published | idle CPU |
|---|---|---|---|---|---|---|---|---|---|
| standard (100 documents / 10 MiB) | 100 | 720.4ms | 1473.5ms | 32.0ms | 80.7ms | 0.9ms | 1.4ms | 245.8ms | 1.2% |
| load (1,000 documents / 50 MiB) | 1000 | 5074.6ms | 8311.1ms | 216.6ms | 532.8ms | 4.5ms | 1.1ms | 334.1ms | 3.1% |

Memory:

| fixture | peak RSS | RSS after 0s | 5s | 20s | 60s | footprint (60s) | heap main / search / parse (60s) |
|---|---|---|---|---|---|---|---|
| standard (100 documents / 10 MiB) | 754.0MiB | 754.3MiB | 715.9MiB | 295.3MiB | 296.0MiB | 204.9MiB | 16.5 / 116.9 / 6.0MiB |
| load (1,000 documents / 50 MiB) | 2798.5MiB | 2620.8MiB | 2444.5MiB | 835.7MiB | 841.4MiB | 654.7MiB | 25.7 / 489.4 / 6.1MiB |

Management UI:

| fixture | all documents in the list | select the last document | save to screen (DOM) |
|---|---|---|---|
| standard (100 documents / 10 MiB) | 140.8ms | 101.0ms | 308.8ms |
| load (1,000 documents / 50 MiB) | 239.5ms | 432.9ms | 350.3ms |

## Against the goals

| goal (spec 16.1) | result |
|---|---|
| Warm search p95 within 300 ms on the standard fixture | Met (80.7ms) |
| About 1 second from a normal save to the updated view | Met (308.8ms to the screen; 350.3ms even under load) |
| CPU does not keep spinning while idle | Met (1.2%, 3.1% in the first 5 seconds, which include the one garbage collection after the operations, see below) |

## Memory

- **What stays: the search index.** The search worker holds the index of the open documents: about 117 MB of heap for the 10 MiB fixture and about 489 MB for 50 MiB. With 452 Markdown files taken from `node_modules` (7.6 MiB, real text), the search worker's heap in the daemon was 80 MB, the daemon settled at about 263 MiB of RSS and 191 MiB of footprint, and search p95 was 14 ms. A separate script that builds the same index outside the daemon and compares the heap after collection gives the main parts: MiniSearch's inverted index about 44 MB, the extracted sections as written about 9.8 MB, and the normalized copies for literal matches about 7.7 MB (the last two include the arrays and objects that hold the text, not only the strings). These script figures are not a breakdown of the 80 MB.
- **The peak is temporary.** During the operations, RSS reaches about 750 MiB on the standard fixture and about 2.8 GiB under load, then drops within 20 seconds after the operations end. Most of the peak is the search worker: MiniSearch builds a result object for every entry that matches a term, and the fixtures repeat the same seven sentences, so most queries match most sections (114,000 entries under load). With the real Markdown files above, the peak was about 610 MiB.
- **Garbage collection after activity.** An idle Node.js thread does not run a full collection on its own, so garbage from parsing, indexing, and searching stayed in the heap and in RSS. Each thread now collects once after activity stops: the search and analysis workers 2 seconds after their requests pause, and the daemon's main thread when its heap has grown by 8 MiB or more and it was idle for a 2-second interval (`apps/cli/src/diagnostics/idle-collect.ts`). Requests made while a worker collects wait for it, and that wait does not count against their time limits, for up to 10 seconds from the start of the collection. After that they are sent anyway, and their usual time limits and worker recovery apply. A collection that comes due while requests are in flight is not dropped; it runs after the next pause. Before this, with the real Markdown files and no forced collection, RSS stayed at about 500 MiB and the footprint at 445 MiB after 60 seconds (the analysis worker kept 67 MB of heap, 8 MB after collection; the main thread about 50 MB, 16 MB after collection).
- **Earlier versions of this page** reported the RSS right after the operations (1.0 GB and 2.8 GB), which is close to the peak, not what the daemon keeps.
- **Search work that does not change results.** Sections already found by a stronger stage (exact, then prefix, then spelling variations), and entries outside the searched documents, are excluded inside MiniSearch before it builds result objects for them (a document boost of 0). MiniSearch still makes the same lookups in the same order as before, including stages that repeat the previous one: it drops the postings of replaced and removed entries while it walks the terms, they count in scores until then, and a walk can leave some for the next one, so skipping a lookup would change later scores until the index is cleaned up. Excerpts reuse the normalized text kept for literal matches. Every hit, match kind, score, and excerpt stays the same: `apps/cli/src/search/search-ranking.test.ts` records the hits of 56 queries, on a fresh index and twice on an index with replaced, removed, and abandoned entries not yet cleaned up (recorded with the previous code). A comparison of the previous and current index on 220 queries each over the real Markdown files and the 10 MiB fixture found no difference. Search p95 went from 175.7 to 80.7 ms on the standard fixture and from 1200.2 to 532.8 ms under load.
- **Not done.** Shrinking the index itself (replacing MiniSearch's nested maps with a compact posting format) would need its own scoring, prefix, and spelling variation matching, and its effect has to be measured including memory outside the JavaScript heap. Lowering the peak further would need changes inside MiniSearch's search (aggregating scores without a result object per entry). Limiting the worker heap (`resourceLimits`) does not reduce what the index needs, and reaching the limit stops the worker and its index.

## Not met or not investigated

- Search p95 on the load fixture was 532.8ms. The load fixture has no time goal, but search gets slower with many documents.
- The tables show a single run. On other runs on the same machine, cold open, indexing, search, and update published differed by less than 15%. The management UI items vary more because they include the browser (list 104 to 176ms, select 90 to 144ms on the standard fixture; save to screen was 839.5ms on one of three runs on 2026-10-04, in a run where list also took 4.1ms instead of about 1ms). List and read take a few milliseconds, so their ratios vary a lot. Peak RSS also varies between runs (945 MiB and 755 MiB on the standard fixture).
- Diagnostics (`daemon.diagnostics`) trigger no index sync or similar work unless garbage collection is requested. While diagnostics synced the index on every call, idle CPU measured 0.9% on the standard fixture (the diagnostics work after the idle period was counted).
- Nothing was measured on Linux, Windows, Firefox, or WebKit.

## Resource checks (PERF-002 to 005)

`tests/integration/resources.test.ts` checks resources with the daemon's diagnostics (IPC `daemon.diagnostics`): the number of watched directories and of watchers created and closed, event subscribers, unwritten events per notification connection, render grants, items each service retains, the heap of the search and analysis workers and the items the search index retains, active Node.js resources by type, RSS, heap, and CPU time. With `collectGarbage: true`, the daemon first brings the search index up to date with the current documents and cleans up removed items (MiniSearch vacuum), then runs one GC on the main thread and on each worker thread and measures the heap. If the daemon starts stopping during diagnostics, they end with `E_DAEMON_STOPPING` without waiting for the sync (so they never delay the stop).

- With 1,000 documents open, the management UI lists all of them, the last document can be selected and shown, and saves are reflected on screen (PERF-002, `tests/e2e/ux.spec.ts`).
- After 100 open/close cycles and 20 watch rule add/remove cycles, the number of watched directories and active resources does not grow, and every removed watcher has finished closing (created minus closed equals the number of watched directories) (PERF-003).
- Continuous memory growth (PERF-003, spec 16.1): after 30 rounds of "rewrite, open, read, search, take and release a render grant, close" on a document of about 40 KiB, three intervals of 40 rounds follow. At the end of each interval, the heap after GC and the retained item counts are measured on the daemon's main thread, the search worker, and the analysis worker (there is no fixed wait; the diagnostics above wait for the sync and cleanup).
  - The items the main thread retains (analysis results, revision records, render grants and conversion results, index records, pending waiters, sessions) and the items the search index retains (committed and staged documents, index entries, terms, items awaiting cleanup) are the same in all three intervals.
  - Heap growth per interval is under 1 MiB on the main thread and on each worker (measured on macOS: about +0.3 MiB and +0.1 MiB on the main thread, under +0.1 MiB on the workers).
  - Leaks make the test fail: keeping about 40 KiB per read on the main thread adds about 2.0 MB per interval, and keeping an array of 8,192 elements per index commit in the search worker adds about 2.6 MB per interval.
  - Items attached to records of closed documents (kept in the state; reopening uses the same ID) stop growing at the number of documents that have ever been opened.
- A client that does not read notifications does not block 50 consecutive updates or other clients' operations (PERF-004). The check for connections whose writes are blocked is in `apps/cli/src/server/http/management.test.ts`. After sending notifications until the receiver's socket is full and then 50,000 more, each connection's queue stays within the limit (256 events plus one resync event). Reading connections receive the resync event and later events, and connections whose writes make no progress are closed after the timeout (60 seconds by default) and unsubscribed.
- After 30 notification connect/disconnect cycles, no subscriptions remain, and 3 seconds of idle use less than 150 ms of CPU time (PERF-005).
