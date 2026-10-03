# vde-open

[日本語](README.ja.md)

A local document viewer for agents and people who work from the same material. Open Markdown and HTML documents, read them in a management UI in the browser, and let an agent search and read the same documents from the CLI. An agent can also ask a person questions, and the person submits the answers from the management UI.

- Agents can search and read only the documents you opened (closed documents and whole directories are never searched).
- When you save a document, the management UI updates automatically.
- HTML is shown on a separate origin from the management UI, without running scripts (by default).
- The state is kept by a local daemon and is never sent to an external service.

## Install

Node.js 24 or later is required (this repository pins 24.21.0 in `mise.toml`).

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test:pack                              # builds artifacts/vde-open-0.1.0.tgz and verifies an install in a separate directory
bun add -g ./artifacts/vde-open-0.1.0.tgz   # recommended: user-level install into ~/.bun/bin
```

- We recommend installing it once per user with Bun. `~/.bun/bin` does not depend on which Node.js version is active, so switching Node.js versions (with mise and similar tools) does not remove `vo`. Bun is only used to install; the commands run on Node.js (`#!/usr/bin/env node`), so Node.js 24 or later must be on your `PATH`. Running it on the Bun runtime (`bun --bun`) is not tested.
- `npm install -g ./artifacts/vde-open-0.1.0.tgz` also works, but it installs into the prefix of the active Node.js version.
- Installing it per project is not recommended. There is one daemon per user, so different versions in different projects would talk to the same daemon.
- Always start the path with `./`. Without it, the path is treated as a GitHub repository name.

Installing does not change shell files such as `.zshrc`, and runs no build or install scripts (the tarball bundles every dependency). The package is not published to npm.

## `vde-open` and `vo`

The same CLI is installed under two names. Both use the same state and daemon.

- `vde-open`: the full name.
- `vo`: the short name.

If you already have a different `vo` (another tool's command, an alias, and so on), installing never overwrites or deletes it.

- If the install target's bin directory (for `npm install -g`, npm's global bin) already has another `vo` file, npm stops with `EEXIST`. Do not use `--force`; it replaces the existing `vo`. Install with Bun instead, or into another prefix (for example `npm install -g --prefix ~/.local/vde-open ./artifacts/vde-open-0.1.0.tgz`) and use `vde-open` from that bin directory.
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
ln -s "$PWD/skills/vde-open" ~/.claude/skills/vde-open   # Claude Code
ln -s "$PWD/skills/vde-open" ~/.codex/skills/vde-open    # Codex
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

## Verified scope

| Scope | Status |
|---|---|
| macOS (Darwin 25.6.0, arm64), Node.js 24.21.0 | Verified (format, lint, typecheck, unit/integration, build, pack, e2e) |
| Linux, Windows | Not verified yet (CI is defined in `.github/workflows/ci.yml`) |
| Browsers (macOS) | Chromium (Playwright's Chrome Headless Shell): the full suite is verified. Firefox 155 and WebKit 26.6 (Playwright 1.63.0): the view isolation, CSP, HTML bridge, and authentication tests (`pnpm test:e2e:cross`) are verified |
| Browsers (not verified) | Other UI interactions in Firefox and WebKit (search, answer panel, narrow screens, a list of 1,000 documents) are not verified |
| Markdown syntax | As described in "Markdown display limits" above. Full CommonMark and GFM are not verified |

More details: [docs/performance.md](docs/performance.md) (measurements), [docs/architecture.md](docs/architecture.md) and [docs/security-model.md](docs/security-model.md) (design). Development records (in Japanese): [docs/implementation-status.md](docs/implementation-status.md), [docs/dependency-validation.md](docs/dependency-validation.md), and [docs/adr/](docs/adr/).

## License

[MIT](LICENSE). Bundled dependencies keep their own licenses. Their list and license texts are in `THIRD_PARTY_NOTICES.md` in the package (generated by `pnpm build` from what was bundled).
