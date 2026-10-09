# Security model

[日本語](security-model.ja.md)

## What is protected

- Access to management operations (documents, search, and answer submission) from external websites and displayed documents.
- Documents that are not open, and files that are not registered (including secret files).
- Answer submission. Answers are submitted only when a person submits them in the management UI.

## Trust boundaries

| Party | Treatment |
|---|---|
| CLI and agents (the same OS user) | Mutual check with the daemon using the IPC key (inside the runtime directory, readable only by the user) |
| Management UI | No authentication. Open the `127.0.0.1` URL directly. Host, Origin, and `Sec-Fetch-Site` are checked. State-changing requests accept JSON only |
| Document view (iframe) | Not trusted. Served on a separate port (origin) from the management UI and restricted with `sandbox` and CSP. It cannot call the management API directly |
| Scripts in documents (interactive) | Not trusted. They run only in HTML that the user explicitly allowed. They can load only registered files. From HTML, they can only get and replace the draft answer; they cannot submit it |
| Browser for PDF export | Started by the daemon only when a person presses "Export PDF": Google Chrome or Microsoft Edge found in its usual install location, or the executable given in `VDE_OPEN_BROWSER`. It runs headless with a temporary profile and is driven over a pipe (no port is opened). The page it prints is written by the daemon; HTML loads only sanitized temporary copies of registered CSS |
| External network | The daemon never makes outbound requests. External images, CSS, and fonts are not loaded |

Standalone images retain the same render grant and source-size limits. Their original bytes are served as an image asset, including SVG, and shown only in `<img>`. The asset CSP (`default-src 'none'; style-src 'unsafe-inline'; sandbox`) blocks scripts and external references even when an SVG URL is opened directly. Unregistered files are never served.

## Main measures

- A render grant (256 random bits) is bound to the document, the revision, the view mode, how many times the document was closed, and the generation of the script permission. It is revoked when the document is closed, the permission is withdrawn, the grant is released, or the daemon restarts. At most 64 grants are retained across the daemon; excess grants expire oldest first (ADR-0008, 0012, 0014).
- Only files whose logical path exactly matches a registered one are served. References that leave the assets root through symlinks or `..`, files whose names start with ".", and files of the wrong type are rejected (ADR-0009).
- Static HTML is processed on a parse5 syntax tree: scripts, event attributes, embeds, base, automatic navigation, form targets, and external references are removed, and the output is parsed again to verify it. CSS is processed with css-tree, and external references and escape-based bypasses are neutralized.
- Interactive HTML limits CSP `script-src` and `connect-src` to the render grant, and never adds `allow-same-origin`. The MessagePort is handed over only once, to the iframe that is showing the document, and frames are checked for size, rate, order, and shape. Draft answers saved from HTML check the render grant again inside the save transaction (ADR-0012).
- Answers are submitted only from the submit button of the management UI. The submitted content is taken from the draft answer saved on the server. Submission is idempotent per ID, and a mismatch in conditions is a conflict (ADR-0011).
- Markdown PDF export renders the print document with the same rules as the view: raw HTML is escaped, links stay links only for headings in the document, http(s), and mailto, and only images registered for the revision are included, as data URLs. The page carries the CSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`, so it runs no script and makes no request. The title in the page header is escaped as a CSS string. HTML PDF export also uses the static view sanitizer and runs no script. Only registered CSS is written to renamed temporary files; images and fonts are embedded as data URLs. Its CSP is `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline' file:; base-uri 'none'; form-action 'none'`. References to unregistered files and external URLs are removed by the static transform. The HTML and CSS (including embedded images and fonts, at most 256 MiB) and the browser profile live in a private temporary directory (0700) that is removed after each export; one left by a daemon that was killed is removed when a daemon next starts, once it is older than an hour (only real directories owned by the user). The browser's sandbox is never turned off. Exports run one at a time within 60 seconds, and the browser is stopped with its helpers (its process group on POSIX, its process tree on Windows) on timeout, when the request is aborted, or when the daemon stops. A message from the browser that cannot be read ends that export, not the daemon (ADR-0013).
- Logs never contain IPC keys, render grants, answers, or document text.
- To show which repository a document is in, the daemon reads Git metadata next to open documents: the `.git` file, `commondir`, `HEAD`, and the `gitdir` back-link of a worktree. Whoever owns those directories can write them, so they are untrusted input: regular files only, opened without following a final symlink and without blocking on a FIFO, at most 4 KiB each. `git` is never run (it would read that directory's Git configuration). A `.git` file or symlink that points into another repository is not placed in that repository: worktrees must be pointed back to by the repository, and a symlinked `.git` or a `.git` file without `commondir` makes the checkout its own repository. On Windows, a path taken from that metadata whose root is not a drive letter (UNC and device paths) and differs from the document's root is rejected before any filesystem access, so the metadata cannot make the daemon connect to another host directly. The UI and the CLI receive only the repository and checkout paths, the worktree name, the branch name, and the document's canonical path (the same kind of information as the absolute paths they already receive).

## What is not protected

- Processes or other OS users on the same machine that can connect to the management listener. The management UI/API does not verify identity; local clients can read and manage documents and answers.
- Vulnerabilities in the browser itself.
- Requests the browser started for PDF export makes on its own. It is started with background networking, component updates, sync, and extensions disabled, and the page it prints makes no request.
- Scripts in interactive HTML navigating their own iframe or consuming CPU and memory. Interactive mode is not a way to run arbitrary hostile scripts safely.
- Reaching another host indirectly while reading Git metadata: a directory on the way that is a symlink (reparse point) to a UNC path, or a network drive with a drive letter. This is the same as opening a document stored in such a place.

## Verification

How the acceptance tests (SEC-001 to 020, FB-007 to 011, FB-022, and others) map to tests is recorded in `docs/implementation-status.md` (in Japanese).
