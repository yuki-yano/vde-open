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
- Idle CPU: the share of CPU time the daemon process used during 5 seconds of idle.
- RSS: the RSS of the daemon process after the idle period (including the analysis and search worker threads). This is a single measurement; whether memory keeps growing is not judged from it (see "Resource checks" below).

## Results (2026-10-03)

Environment: macOS (darwin arm64), Apple M5 Max (18 cores), Node.js v24.21.0, Chromium (Playwright 1.63.0, headless).

Daemon and IPC:

| fixture | documents | cold open | indexing | search p50 | search p95 | list | read | update published | idle CPU | RSS |
|---|---|---|---|---|---|---|---|---|---|---|
| standard (100 documents / 10 MiB) | 100 | 724.5ms | 1560.2ms | 66.3ms | 186.0ms | 1.6ms | 3.1ms | 246.5ms | 0.1% | 1057.9MiB |
| load (1,000 documents / 50 MiB) | 1000 | 5163.7ms | 8973.8ms | 425.4ms | 1154.4ms | 4.6ms | 1.1ms | 323.1ms | 0.3% | 2936.7MiB |

Management UI:

| fixture | all documents in the list | select the last document | save to screen (DOM) |
|---|---|---|---|
| standard (100 documents / 10 MiB) | 136.4ms | 104.3ms | 307.7ms |
| load (1,000 documents / 50 MiB) | 232.1ms | 423.6ms | 339.4ms |

## Against the goals

| goal (spec 16.1) | result |
|---|---|
| Warm search p95 within 300 ms on the standard fixture | Met (186.0ms) |
| About 1 second from a normal save to the updated view | Met (307.7ms to the screen; 339.4ms even under load) |
| CPU does not keep spinning while idle | Met (0.1%, 0.3%; up to 1.0% in other runs) |

## Not met or not investigated

- **RSS is large.** About 1.1 GB on the standard fixture and about 2.9 GB under load. The cause has not been investigated. The guess is that the MiniSearch index in the search worker (long sections are split into overlapping parts) and the V8 heap that grew while indexing are not returned after the idle period (Not verified). Values after a forced GC were not measured.
- Search p95 on the load fixture was 1154.4ms. The load fixture has no time goal, but search gets slower with many documents.
- The table shows a single run, after the code and UI were translated to English. Compared with other runs on the same day, cold open, indexing, search, and update published differed by less than 15%. The management UI items vary more because they include the browser (list 104 to 176ms, select 90 to 144ms on the standard fixture). List and read take a few milliseconds, so their ratios vary a lot (list was 0.8 to 1.6ms). Idle CPU was 0.1 to 1.0% depending on the run.
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
