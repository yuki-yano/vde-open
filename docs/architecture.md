# Architecture

[日本語](architecture.ja.md)

vde-open runs as three parts: the CLI, a local daemon, and the management UI in the browser. Only the daemon holds state; the CLI and the management UI send requests to it.

```text
CLI (vde-open / vo) ──IPC (Unix socket, mutual check with a key)──▶ daemon ──▶ state (state.json, blobs/)
                                                                  │
Management UI (React) ◀──management listener (127.0.0.1, session token)──┤
                                                                  │
Document view (iframe) ◀──preview listener (127.0.0.1, separate port, render grant)──┘
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
- Rendering: `apps/cli/src/render/render-service.ts` issues render grants bound to a document, a revision, a view mode, and a session, and `apps/cli/src/server/http/preview.ts` serves them (ADR-0008, 0009, 0012).
- Questions and answers: `apps/cli/src/feedback/service.ts` (ADR-0011).
- Notifications: `apps/cli/src/server/event-hub.ts`. Server-sent events carry only IDs and states, never document text. Each connection holds at most 256 unwritten events; events beyond that are dropped and folded into one `resync-required` event (`apps/cli/src/server/http/event-queue.ts`). When the session expires or is revoked, or writes make no progress for 60 seconds, the connection stops sending and the socket is closed (`apps/cli/src/server/http/management.ts`).

## Management UI

- A one-time URL (`vo ui`) creates a session; the token is kept in sessionStorage (the URL fragment is removed immediately).
- The document list, the viewer, search (`Cmd/Ctrl+K`), and the answer panel. Notifications trigger a refetch of the list and questions, and a gap in notifications triggers a full resync.
- HTML is shown in a sandboxed iframe on a separate origin. Only interactive views exchange draft answers with the management UI, over a MessagePort (`apps/web/src/lib/bridge-host.ts`, `use-bridge.ts`).

## Distribution

`pnpm build` builds the UI and the CLI, and `pnpm test:pack` creates the tarball and verifies an install in a separate directory (`scripts/pack-smoke.ts`). All runtime dependencies are bundled (ADR-0001), and installing runs no build or scripts. The build writes license notices for the bundled dependencies (JS, CSS, fonts) to `THIRD_PARTY_NOTICES.md` from the list of bundled modules and includes it in the tarball (`scripts/notices.ts`).

## Design decisions

See `docs/adr/` (0001 to 0012, in Japanese).
