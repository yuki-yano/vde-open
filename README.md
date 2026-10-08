# vde-open

[日本語](README.ja.md)

A local document viewer for agents and people who work from the same material. Open Markdown and HTML documents, read them in a management UI in the browser, and let an agent search and read the same documents from the CLI. An agent can also ask a person questions, and the person submits the answers from the management UI.

- Agents can search and read only the documents you opened.
- When you save a document, the management UI updates automatically.
- HTML is shown on a separate origin from the management UI, without running scripts (by default).
- The state is kept by a local daemon and is never sent to an external service.

## Install

Node.js 24 or later is required.

```bash
bun add -g vde-open      # recommended
npm install -g vde-open  # also works
```

- Bun installs `vo` into `~/.bun/bin`, so it stays available when you switch Node.js versions (with mise and similar tools). `npm install -g` installs it for the active Node.js version only. Either way, the commands run on the Node.js found on your `PATH`.
- Do not install it per project. There is one daemon per user, so projects with different versions would talk to the same daemon.
- Installing does not change shell files such as `.zshrc` and runs no build or install scripts (every dependency is bundled).

To install from a clone of this repository (Node.js 24.21.0 is pinned in `mise.toml`):

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test:pack                                   # builds artifacts/vde-open-<version>.tgz and verifies an install in a separate directory
bun add -g "$PWD/artifacts/vde-open-0.1.8.tgz"   # bun add -g needs an absolute path
```

## `vde-open` and `vo`

The same CLI is installed as `vde-open` and as the short name `vo`. Both use the same state and daemon.

Installing never overwrites or removes an existing `vo` (another tool's command, an alias, and so on):

- If npm's global bin already has another `vo`, `npm install -g` stops with `EEXIST`. Do not add `--force`, which replaces it. Install with Bun, or into another prefix (`npm install -g --prefix ~/.local/vde-open vde-open`) and run `vde-open` from that bin directory.
- If another `vo` comes first on `PATH`, use `vde-open`, or define your own alias (for example `alias vdo=vde-open`).

## Basic usage

```bash
vo open README.md docs/design.md        # open documents (starts the daemon if needed)
vo open docs -w                          # open a directory and follow new documents
vo ui                                    # open the management UI (one-time URL)
vo list --json                           # list open documents
vo search "authentication design" --json # search open documents
vo read <documentId> --section sec_0003 --json   # read a section
vo close docs/design.md                  # remove from the list (the file is not deleted)
vo daemon stop                           # stop the daemon
```

For how agents search, read, and ask questions, see [docs/agent-usage.md](docs/agent-usage.md).

## Agent skill

[`skills/vde-open/SKILL.md`](skills/vde-open/SKILL.md) teaches an agent (Claude Code, Codex, and others that read `SKILL.md`) when and how to use `vo`. It is included in the package. Link or copy the directory into your agent's skill directory:

```bash
# Installed with Bun: the skill is in the global package directory.
ln -s ~/.bun/install/global/node_modules/vde-open/skills/vde-open ~/.claude/skills/vde-open   # Claude Code
ln -s ~/.bun/install/global/node_modules/vde-open/skills/vde-open ~/.codex/skills/vde-open    # Codex
# Installed with npm: use "$(npm root -g)/vde-open/skills/vde-open" instead.
# From a clone of this repository: use "$PWD/skills/vde-open".
```

## Search scope

- Search covers **only the documents that are open right now**. Closed documents, files that are not open, and whole directories are never searched.
- Japanese text is split into words with `Intl.Segmenter`. Words match exactly, by prefix, or, for alphanumeric words, with up to one character of difference.
- In the management UI, press `Cmd/Ctrl+K` to search.

## HTML display limits

- By default (static), scripts do not run. Scripts, event attributes, iframe/object/embed, base, automatic navigation (meta refresh), form targets, and external images, CSS, and fonts are removed. Links cannot be clicked inside the view; open them from "Links in this document".
- Only files that the document references, inside the assets root (by default the document's directory), can be loaded. Files whose names start with "." such as `.env` and `.git` are never loaded. Set the scope with `--assets-root` and individual files with `--asset`.
- Scripts run only in HTML opened with `--html-mode interactive`. Use it only with HTML that you or the agent prepared and trust: scripts can load only registered files and cannot reach the management UI, the management API, or other files, but this does not block every outbound request (navigation inside the view, for example). After the daemon restarts, the HTML is static until you allow scripts again in the management UI.
- "Differences from the original document" in the management UI lists what the view changed, why, and what to do.

## Markdown display

Use "Color palette" in the management header to choose Standard (the default), GitHub, Gruvbox, Catppuccin, or GitHub High Contrast. Light, Dark, and Match OS setting are separate controls. Both preferences are saved in the browser. The palette applies to the management UI and Markdown, including code highlighting; HTML keeps its own styling and PDFs keep their print styling.

"Wide view" in the document header expands Markdown to the available width. Press it again to return to the standard width. The width preference is saved in the browser. Tables keep their column widths and scroll horizontally when they do not fit. To scroll with the keyboard, focus the table and press the left or right arrow key.

### Display limits

Markdown is rendered with TanStack Markdown 1.0.0. It is not fully compatible with CommonMark or GFM.

- Raw HTML is not rendered; it is shown as text.
- External images are not loaded. Only images under the document's directory are shown.
- Code is highlighted only for JS, JSX, TS, TSX, JSON, YAML, HTML, CSS, Bash, and Markdown. Code larger than 256 KiB and other languages are not highlighted.
- Documents that cannot be parsed within 2 seconds, or that have more than 100,000 elements or more than 64 levels of nesting, are shown as source.

## Exporting to PDF

"Export PDF" in the header of a document saves the shown revision as a PDF, without a print dialog.

- Markdown PDFs are A4 on a white background. Every page has the document title in the header and the page number ("3 / 12") in the footer, and the headings become PDF bookmarks.
- The daemon prints it with the Google Chrome or Microsoft Edge (131 or later) installed on the machine; nothing is downloaded. To use another Chromium-based browser or another location, set `VDE_OPEN_BROWSER` for the daemon to the absolute path of the executable, then run `vo daemon restart`.
- For Markdown, the rules of the view apply: raw HTML is shown as text, only images registered for the document are included (others show their alternative text), and links to other local documents become plain text.
- The file name is the document's file name with `.pdf` (`README.md` → `README.pdf`); a document read from stdin uses its title.
- Markdown and any HTML text without a registered font use the fonts installed on the machine, so they look slightly different on each OS.
- HTML is exported using the static view rules, its own CSS (including `@media print` and `@page`), and registered CSS, images, and fonts. Without a page rule, it uses A4 with 20 mm margins. Markdown typography, headers, and footers are not added. Even an interactive document is exported from the saved HTML without running scripts; changes made by interacting with it are not included.
- Printing must finish within 60 seconds.

## Where the state is stored, and stopping

- The state (open documents, revisions, questions and answers) is stored here. Change it with `VDE_OPEN_HOME`.
  - macOS: `~/Library/Application Support/vde-open`
  - Linux: `$XDG_STATE_HOME/vde-open` (or `~/.local/state/vde-open` if unset)
  - Windows: `%LOCALAPPDATA%\vde-open`
- Stop the daemon with `vo daemon stop`, and check it with `vo daemon status`.
- Management UI preferences such as the color theme and the view mode are stored in the browser.

## Asking a person and getting answers

```bash
vo ask questions.json --view review.md --json    # open a document and ask about it
vo feedback wait <requestId> --timeout 120 --json
vo feedback ack <requestId> --submission-id <id> --json
```

The person answers in the answer panel of the management UI. The answers are submitted only when they press "Send answers to the agent"; draft answers are never returned to the agent. Do not use this to collect secrets such as passwords or API keys.

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
| Linux and macOS on CI (GitHub Actions `ubuntu-latest` and `macos-latest`, Node.js 24.21.0) | Verified (format, lint, typecheck, unit/integration, build, pack, e2e; `.github/workflows/ci.yml`) |
| Windows on CI (`windows-latest`, Node.js 24.21.0) | Verified: build, pack smoke (install, both bins, IPC, starting and stopping the daemon, JSON output, the UI and workers), and the daemon and document integration tests. The other unit and integration tests and the e2e tests are not run on Windows |
| Browsers | Chromium (Playwright's Chrome Headless Shell): the full suite is verified. Firefox and WebKit (Playwright 1.63.0): the view isolation, CSP, HTML bridge, and authentication tests (`pnpm test:e2e:cross`) are verified. Other UI interactions in Firefox and WebKit (search, answer panel, narrow screens, a list of 1,000 documents) are not verified |
| PDF export | macOS (development machine): verified with Google Chrome 154 and Microsoft Edge 154. Linux on CI: verified with the runner's Google Chrome (e2e). Windows: printing with a real browser is not verified (the pack smoke test checks rendering the print document) |

More details: [docs/performance.md](docs/performance.md) (measurements), [docs/architecture.md](docs/architecture.md) and [docs/security-model.md](docs/security-model.md) (design). Development records (in Japanese): [docs/implementation-status.md](docs/implementation-status.md), [docs/dependency-validation.md](docs/dependency-validation.md), and [docs/adr/](docs/adr/).

## Developing with a linked CLI

From the repository root, build once, link the CLI package globally, and start the watcher:

```bash
pnpm install --frozen-lockfile
pnpm build
cd apps/cli
bun link
bun link -g vde-open
cd ../..
pnpm build:watch
```

`build:watch` rebuilds when the sources, the build configuration, or the packaged files change; a failed build keeps the last successful output. The next linked CLI invocation uses the new build, but the watcher does not restart your daemon: run `vo daemon restart`, then `vo ui`. Restarting keeps registered documents and saved answers, but changes the UI address and invalidates earlier browser sessions and interactive HTML permissions.

For frequent UI changes, use `pnpm dev` instead. It runs the daemon from source with a separate `.dev-home` and serves the UI with Vite HMR. It does not rebuild the linked CLI or restart the backend when its source changes. To run CLI commands against it, set `VDE_OPEN_HOME` to the absolute path of `.dev-home` (for example, `VDE_OPEN_HOME="$PWD/.dev-home" vo list` from the repository root).

## Releasing

Releases are published to npm from GitHub Actions with trusted publishing (OIDC) and provenance. No npm token is stored: the trusted publisher on npmjs.com is this repository's `publish.yml`, and publishing with tokens is disallowed.

1. Update `version` in `apps/cli/package.json` and commit it to `main`.
2. Push a tag for that version: `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/publish.yml` checks that the tag matches the version, runs the checks and the pack smoke test, and publishes the tarball.

## License

[MIT](LICENSE). Bundled dependencies keep their own licenses. Their list and license texts are in `THIRD_PARTY_NOTICES.md` in the package (generated by `pnpm build` from what was bundled).
