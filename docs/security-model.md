# Security model

[日本語](security-model.ja.md)

## What is protected

- Management rights (opening and closing documents, search, and submitting questions and answers).
- Documents that are not open, and files that are not registered (including secret files).
- Answer submission. Answers are submitted only when a person submits them in the management UI.

## Trust boundaries

| Party | Treatment |
|---|---|
| CLI and agents (the same OS user) | Mutual check with the daemon using the IPC key (inside the runtime directory, readable only by the user) |
| Management UI | A session token created from a one-time URL (bootstrap ticket, 60 seconds). Host, Origin, and `Sec-Fetch-Site` are checked. State-changing requests accept JSON only |
| Document view (iframe) | Not trusted. Served on a separate port (origin) from the management UI and restricted with `sandbox` and CSP. It never holds the management token |
| Scripts in documents (interactive) | Not trusted. They run only in HTML that the user explicitly allowed. They can load only registered files. From HTML, they can only get and replace the draft answer; they cannot submit it |
| External network | The daemon never makes outbound requests. External images, CSS, and fonts are not loaded |

## Main measures

- A render grant (256 random bits) is bound to the document, the revision, the view mode, the session, how many times the document was closed, and the generation of the script permission. It is revoked when the document is closed, the session expires, the permission is withdrawn, or the grant is released (ADR-0008, 0012).
- Only files whose logical path exactly matches a registered one are served. References that leave the assets root through symlinks or `..`, files whose names start with ".", and files of the wrong type are rejected (ADR-0009).
- Static HTML is processed on a parse5 syntax tree: scripts, event attributes, embeds, base, automatic navigation, form targets, and external references are removed, and the output is parsed again to verify it. CSS is processed with css-tree, and external references and escape-based bypasses are neutralized.
- Interactive HTML limits CSP `script-src` and `connect-src` to the render grant, and never adds `allow-same-origin`. The MessagePort is handed over only once, to the iframe that is showing the document, and frames are checked for size, rate, order, and shape. Draft answers saved from HTML check the render grant again inside the save transaction (ADR-0012).
- Answers are submitted only from the submit button of the management UI. The submitted content is taken from the draft answer saved on the server. Submission is idempotent per ID, and a mismatch in conditions is a conflict (ADR-0011).
- Logs never contain tokens, tickets, render grants, answers, or document text.

## What is not protected

- A malicious process running as the same OS user (it can read the key and the state).
- Vulnerabilities in the browser itself.
- Scripts in interactive HTML navigating their own iframe or consuming CPU and memory. Interactive mode is not a way to run arbitrary hostile scripts safely.

## Verification

How the acceptance tests (SEC-001 to 020, FB-007 to 011, FB-022, and others) map to tests is recorded in `docs/implementation-status.md` (in Japanese).
