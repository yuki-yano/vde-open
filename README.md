# vde-open

[日本語](README.ja.md)

A local document viewer for agents and people who work from the same material. Open Markdown and HTML documents, read them in a management UI in the browser, and let an agent search and read the same documents from the CLI. An agent can also ask a person questions, and the person submits the answers from the management UI.

- Agents can search and read only the documents you opened (closed documents and whole directories are never searched).
- When you save a document, the management UI updates automatically.
- HTML is shown on a separate origin from the management UI, without running scripts (by default).
- The state is kept by a local daemon and is never sent to an external service.

## Install

Node.js 24 or later is required.

```bash
bun add -g vde-open      # recommended: user-level install into ~/.bun/bin
npm install -g vde-open  # also works
```

- We recommend installing it once per user with Bun. `~/.bun/bin` does not depend on which Node.js version is active, so switching Node.js versions (with mise and similar tools) does not remove `vo`. Bun is only used to install; the commands run on Node.js (`#!/usr/bin/env node`), so Node.js 24 or later must be on your `PATH`. Running it on the Bun runtime (`bun --bun`) is not tested.
- `npm install -g` installs into the prefix of the active Node.js version.
- Installing it per project is not recommended. There is one daemon per user, so different versions in different projects would talk to the same daemon.

Installing does not change shell files such as `.zshrc`, and runs no build or install scripts (the package bundles every dependency). Releases are published from GitHub Actions with provenance (see "Releasing").

To install from a clone of this repository (pins Node.js 24.21.0 in `mise.toml`):

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test:pack                              # builds artifacts/vde-open-<version>.tgz and verifies an install in a separate directory
bun add -g "$PWD/artifacts/vde-open-0.1.4.tgz"   # use an absolute path: bun add -g resolves relative paths from its global install directory, not the current one
```

## Developing with a linked CLI

From the repository root, build once and link the CLI package globally:

```bash
pnpm install --frozen-lockfile
pnpm build
cd apps/cli
bun link
bun link -g vde-open
cd ../..
pnpm build:watch
```

`build:watch` builds immediately, then watches the CLI, UI, shared sources, build configuration, and packaged files. Saves are coalesced and builds run one at a time. Both apps and the package files are prepared in a temporary directory before replacing the distribution; a failed build leaves the last successful output in place. The next linked CLI invocation uses the updated build.

The watcher does not start or restart your daemon. After a successful build, run `vo daemon restart`, then `vo ui` to open the updated UI. Restarting preserves registered documents and saved answers, but changes the UI address and invalidates earlier browser sessions and interactive HTML permissions. Stop the watcher with Ctrl+C; it stops an active build and removes its temporary output.

For frequent UI changes, use `pnpm dev` instead. It runs the source daemon with a separate `.dev-home` and serves the UI through Vite HMR. It does not rebuild the linked CLI or automatically restart the backend when its source changes. CLI commands for that environment need the same absolute `VDE_OPEN_HOME` (for example, `VDE_OPEN_HOME="$PWD/.dev-home" vo list` from the repository root).

## `vde-open` and `vo`

The same CLI is installed under two names. Both use the same state and daemon.

- `vde-open`: the full name.
- `vo`: the short name.

If you already have a different `vo` (another tool's command, an alias, and so on), installing never overwrites or deletes it.

- If the install target's bin directory (for `npm install -g`, npm's global bin) already has another `vo` file, npm stops with `EEXIST`. Do not use `--force`; it replaces the existing `vo`. Install with Bun instead, or into another prefix (for example `npm install -g --prefix ~/.local/vde-open ./artifacts/vde-open-0.1.4.tgz`) and use `vde-open` from that bin directory.
- For a `vo` or alias elsewhere, whichever comes first on `PATH` runs. In that case, use `vde-open`. If you want a short name, define an alias in your shell (for example `alias vdo=vde-open`).

## Basic usage

```bash
vo open README.md docs/design.md        # open documents (starts the daemon if needed)
vo open docs -w                          # open a directory and follow new documents
vo ui                                    # open the management UI (one-time URL)
vo list --json                           # list open documents
vo search "認証の設計" --json            # search open documents
vo read <documentId> --section sec_0003 --json   # read a section
vo close docs/design.md                  # remove from the list (the file is not deleted)
vo daemon stop                           # stop the daemon
```

How agents should use it is described in [docs/agent-usage.md](docs/agent-usage.md): read in the order search, outline, then sections; ask questions and get answers; receive draft answers from HTML.

## Agent skill

[`skills/vde-open/SKILL.md`](skills/vde-open/SKILL.md) is a skill that teaches an agent (Claude Code, Codex, and others that read `SKILL.md`) when and how to use `vo`. It is also included in the package. To use it, link or copy the directory into your agent's skill directory:

```bash
# Installed with Bun: the skill is in the global package directory.
ln -s ~/.bun/install/global/node_modules/vde-open/skills/vde-open ~/.claude/skills/vde-open   # Claude Code
ln -s ~/.bun/install/global/node_modules/vde-open/skills/vde-open ~/.codex/skills/vde-open    # Codex
# Installed with npm: use "$(npm root -g)/vde-open/skills/vde-open" instead.
# From a clone of this repository: use "$PWD/skills/vde-open".
```

## Search scope

- Search covers **only the documents that are open right now**. Closed documents, files that are not open, and whole directories are never searched.
- Results come from the revision that was published when you searched. Reading with the `revision` from a result returns the same content that was searched.
- Japanese text is split into words with `Intl.Segmenter`. Search uses exact matches, prefix matches, and fuzzy matches of alphanumeric words with up to one character of difference.
- In the management UI, press `Cmd/Ctrl+K` to search.

## HTML display limits

- By default (static), scripts do not run. Scripts, event attributes, iframe/object/embed, base, automatic navigation (meta refresh), form targets, and external images, CSS, and fonts are removed. Links cannot be clicked inside the view; open them from "Links in this document".
- Only files that the document references, inside the assets root (by default the document's directory), can be loaded. Files whose names start with "." such as `.env` and `.git` are never loaded. Set the scope with `--assets-root` and individual files with `--asset`.
- Scripts run only in HTML opened with `--html-mode interactive`. Scripts can load only registered files and cannot reach the management UI, the management API, or other files. This does not block every outbound request, including navigation inside the view. Use it only with HTML that you or the agent prepared and trust. After the daemon restarts, the HTML shows as a static view until you allow scripts again in the management UI.
- Differences between the original document and the view are listed under "Differences from the original document" in the management UI, with what is affected, why, and what to do.

## Markdown display limits

Markdown is rendered with TanStack Markdown 1.0.0. It is not fully compatible with CommonMark or GFM.

- Raw HTML is not rendered; it is shown as text.
- External images are not loaded. Only images under the document's directory are shown.
- Code is highlighted only for JS, JSX, TS, TSX, JSON, YAML, HTML, CSS, Bash, and Markdown. Code larger than 256 KiB and other languages are not highlighted.
- Documents that cannot be parsed within 2 seconds, or that have more than 100,000 elements or more than 64 levels of nesting, are shown as source.

## Exporting Markdown to PDF

"Export PDF" in the header of a Markdown document saves the shown revision as a PDF, without a print dialog.

- The PDF is an A4 document on a white background (the color theme of the management UI is not used). Every page has the document title in the header and the page number ("3 / 12") in the footer, and the headings become the PDF bookmarks.
- The daemon prints it with the Google Chrome or Microsoft Edge (131 or later) installed on the machine, run headless with a temporary profile that is removed afterwards. Nothing is downloaded. To use another Chromium-based browser, or one in another location, set `VDE_OPEN_BROWSER` to the absolute path of its executable for the daemon (after changing it, run `vo daemon restart`).
- The rules of the view apply: raw HTML is shown as text, only images registered for the document are included (others show their alternative text), and links to other local documents become plain text.
- The file name is the document's file name with `.pdf` (`README.md` → `README.pdf`). A document read from stdin uses its title.
- Fonts are the ones installed on the machine (San Francisco with Hiragino Sans on macOS, Segoe UI with Yu Gothic on Windows, Noto Sans CJK on Linux), so the PDF looks slightly different on each OS.
- HTML documents cannot be exported. Printing must finish within 60 seconds.

## Where the state is stored, and stopping

- The state (open documents, revisions, questions and answers) is stored here. Change it with `VDE_OPEN_HOME`.
  - macOS: `~/Library/Application Support/vde-open`
  - Linux: `$XDG_STATE_HOME/vde-open` (or `~/.local/state/vde-open` if unset)
  - Windows: `%LOCALAPPDATA%\vde-open`
- Stop the daemon with `vo daemon stop`. It stops the daemon no matter which name started it. Check its status with `vo daemon status`.
- Management UI preferences such as the color theme and the view mode are stored in the browser. The open documents follow the daemon's state.

## Asking a person and getting answers

```bash
vo ask questions.json --view review.md --json    # open a document and ask about it
vo feedback wait <requestId> --timeout 120 --json
vo feedback ack <requestId> --submission-id <id> --json
```

The person answers in the answer panel of the management UI. The answers are submitted only when they press "Send answers to the agent". Input before submission (the draft answer) is never returned to the agent. Do not use this to collect secrets such as passwords or API keys.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `vo` runs a different command | Use `vde-open`, or check the order of `PATH` |
| The management UI asks you to open it again from the CLI | Open a new URL with `vo ui` (each URL works once; after the daemon restarts, earlier windows stop working) |
| Exit code 8 (cannot connect to or start the daemon) | Check with `vo daemon status`, and look for leftover files with `vo doctor` |
| Images or CSS are not shown | Open "Differences from the original document" and register them with `--assets-root` or `--asset` |
| Search does not find a document | Check with `vo list --json` that the document is open and its `searchState` is `ready` |
| Export PDF says Google Chrome or Microsoft Edge is needed | Install Chrome or Edge 131 or later, or set `VDE_OPEN_BROWSER` to the absolute path of a Chromium-based browser and run `vo daemon restart` |

## Verified scope

| Scope | Status |
|---|---|
| macOS (Darwin 25.6.0, arm64), Node.js 24.21.0, locally | Verified (format, lint, typecheck, unit/integration, build, pack, e2e) |
| Linux and macOS on CI (GitHub Actions `ubuntu-latest` and `macos-latest`, Node.js 24.21.0) | Verified (format, lint, typecheck, unit/integration, build, pack, and e2e in Chromium, Firefox, and WebKit; `.github/workflows/ci.yml`) |
| Windows on CI (`windows-latest`, Node.js 24.21.0) | Verified: build, pack smoke (install, both bins, IPC, starting and stopping the daemon, JSON output, the UI and workers), and the daemon and document integration tests. The other unit and integration tests and the e2e tests are not run on Windows |
| Browsers (macOS) | Chromium (Playwright's Chrome Headless Shell): the full suite is verified. Firefox 155 and WebKit 26.6 (Playwright 1.63.0): the view isolation, CSP, HTML bridge, and authentication tests (`pnpm test:e2e:cross`) are verified |
| Browsers (not verified) | Other UI interactions in Firefox and WebKit (search, answer panel, narrow screens, a list of 1,000 documents) are not verified |
| Markdown syntax | As described in "Markdown display limits" above. Full CommonMark and GFM are not verified |
| PDF export | macOS (locally): verified with Google Chrome 154 and Microsoft Edge 154. Linux on CI (`ubuntu-latest`): verified with the runner's Google Chrome (e2e). Windows: printing with a real browser is not verified (the pack smoke test checks rendering the print document) |

More details: [docs/performance.md](docs/performance.md) (measurements), [docs/architecture.md](docs/architecture.md) and [docs/security-model.md](docs/security-model.md) (design). Development records (in Japanese): [docs/implementation-status.md](docs/implementation-status.md), [docs/dependency-validation.md](docs/dependency-validation.md), and [docs/adr/](docs/adr/).

## Releasing

Releases are published to npm by GitHub Actions with trusted publishing (OIDC), so no npm token is stored anywhere. The trusted publisher on npmjs.com is set to this repository and the workflow file `publish.yml`, and publishing with tokens is disallowed.

1. Update `version` in `apps/cli/package.json` and commit it to `main`.
2. Push a tag for that version: `git tag v0.1.0 && git push origin v0.1.0`.
3. `.github/workflows/publish.yml` checks that the tag matches the version, runs the checks and the pack smoke test, and publishes the tarball with provenance.

## License

[MIT](LICENSE). Bundled dependencies keep their own licenses. Their list and license texts are in `THIRD_PARTY_NOTICES.md` in the package (generated by `pnpm build` from what was bundled).
