# Architecture

[日本語](architecture.ja.md)

vde-open runs as three parts: the CLI, a local daemon, and the management UI in the browser. Only the daemon holds state; the CLI and the management UI send requests to it.

```text
CLI (vde-open / vo) ──IPC (Unix socket, mutual check with a key)──▶ daemon ──▶ state (state.json, blobs/)
                                                                  │
Management UI (React) ◀──management listener (127.0.0.1, no authentication)──┤
                                                                  │
Document view (iframe/img) ◀──preview listener (127.0.0.1, separate port, render grant)──┘
```

## Workspace layout

| path | role |
|---|---|
| `apps/cli` | The CLI and the daemon. Bundled into `dist/`, which ships both bins and the bundled UI |
| `apps/web` | The management UI (React, Tailwind CSS, shadcn/ui, Base UI). Built and bundled into `apps/cli/dist/web` |
| `packages/shared` | Contracts shared by the CLI, the daemon, and the management UI (Zod schemas, error codes, limits) |
| `packages/document` | Document analysis (headings, sections, titles), HTML and CSS conversion, and Markdown rendering. Knows nothing about files or the daemon |

## Daemon

- Start: the CLI starts it when needed (`apps/cli/src/cli/daemon-control.ts`). Only one runs per state root (a lock with generations; ADR-0005).
- State: `apps/cli/src/persistence/state-store.ts`. Changes run one transaction at a time; blobs are written first, then `state.json` is replaced atomically.
- Documents: `apps/cli/src/documents/service.ts`. Open, close, read, revisions, and watch rules. A revision is determined by the text and the content of the assets it references.
- Watching: `apps/cli/src/watch/watch-service.ts` (Chokidar). Watches only the parent directories of open documents and picks up saves.
- Analysis and search: worker threads (`apps/cli/src/workers/`). Analysis has time and structure limits. Search uses MiniSearch and indexes each section (ADR-0010).
- Rendering: `apps/cli/src/render/render-service.ts` issues render grants bound to a document, a revision, and a view mode, and `apps/cli/src/server/http/preview.ts` serves them (ADR-0008, 0009, 0012).
- Questions and answers: `apps/cli/src/feedback/service.ts` (ADR-0011).
- PDF export: `apps/cli/src/export/pdf-service.ts` (ADR-0013). For `POST /documents/:id/pdf`, a worker of its own renders the revision into one print document (`packages/document/src/print.ts`, with TanStack Markdown's HTML renderer and the link and image rules shared with the viewer in `rendering-rules.ts`). The daemon writes it to a private temporary directory, filling in registered images as data URLs, and prints it with the Google Chrome or Microsoft Edge found by `apps/cli/src/export/browser.ts`. The browser runs headless with a temporary profile and is driven over `--remote-debugging-pipe` (`apps/cli/src/export/cdp.ts`, `Page.printToPDF`). Exports run one at a time. HTML uses `html-print.ts` on the same print worker and the static view transform. Registered CSS is sanitized into temporary files; images and fonts become data URLs. CSS imports, print media and page rules are preserved, and printing waits for the fonts used by print CSS.
- Repositories: `apps/cli/src/documents/repository.ts` finds the Git repository and checkout of each file document by walking up from its path to the nearest `.git`, without running `git`. The common Git directory is the repository key (the checkout directory when `.git` is a symlink or a `.git` file has no `commondir`, since the link cannot be verified). A linked worktree is accepted only when its administrative directory is `<common>/worktrees/<name>` and its `gitdir` file points back to the checkout. Anything else that cannot be verified is `unresolved` and is never placed in a parent repository. `apps/cli/src/documents/repository-tracker.ts` keeps the results in daemon memory only (they are derived from paths and can go stale, so they are not in the state file). Detection runs at daemon start (before requests are accepted), on open, reopen, an explicit refresh, and documents added by a watch rule; never on the automatic reload after a save. Each operation waits up to 2 seconds; a document still being detected keeps its earlier value, or shows `pending`, and is updated when detection finishes. At most 2 filesystem operations of detection run at once across the daemon, so a hung network mount cannot take the whole libuv pool. Every batch gets an increasing number; a result is applied only if no later batch already set that document or checkout, and only to documents still open and not closed since. A change in what the list shows raises the catalog version and sends one `catalog-changed`.
- Notifications: `apps/cli/src/server/event-hub.ts`. Server-sent events carry only IDs and states, never document text. Each connection holds at most 256 unwritten events; events beyond that are dropped and folded into one `resync-required` event (`apps/cli/src/server/http/event-queue.ts`). When writes make no progress for 60 seconds, the connection stops sending and the socket is closed (`apps/cli/src/server/http/management.ts`).

## Management UI

- Open the local URL directly without authentication. The same URL works in other browsers and tabs. `vo ui --print-url` prints it.
- The document list, the viewer, search (`Cmd/Ctrl+K`), and the answer panel. Each row of the flat list shows a second line with the repository, the worktree, and the path within the checkout; the tree groups documents by repository, then worktree. Markdown and HTML icons differ in shape and color (`--format-markdown`, `--format-html`). Notifications trigger a refetch of the list and questions, and a gap in notifications triggers a full resync.
- HTML is shown in a sandboxed iframe on a separate origin. Only interactive views exchange draft answers with the management UI, over a MessagePort (`apps/web/src/lib/bridge-host.ts`, `use-bridge.ts`).
- "Export PDF" in the header of a document posts the shown revision and saves the returned PDF with a download link. The export state is kept per document outside the viewer (`apps/web/src/lib/pdf-export.ts`): switching to another document does not cancel it, and a failure is still shown when the document is shown again. Closing the management UI aborts the request, which stops the browser.

Standalone images use `format: "image"` and retain their original bytes as the revision source. The render grant serves only that image, with its image MIME type, from the separate preview origin. The management UI uses an `<img>` rather than an iframe. Search indexes only the title and path; text reads and PDF export reject image revisions. See ADR-0015.

## Distribution

`pnpm build` builds the UI and the CLI, and `pnpm test:pack` creates the tarball and verifies an install in a separate directory (`scripts/pack-smoke.ts`). All runtime dependencies are bundled (ADR-0001), and installing runs no build or scripts. The build writes license notices for the bundled dependencies (JS, CSS, fonts) to `THIRD_PARTY_NOTICES.md` from the list of bundled modules and includes it in the tarball (`scripts/notices.ts`).

## Design decisions

See `docs/adr/` (0001 to 0015, in Japanese).
