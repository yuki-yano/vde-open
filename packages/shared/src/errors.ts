import { ExitCode } from './exit-codes.ts';

interface ErrorSpec {
  exit: ExitCode;
  retryable: boolean;
}

// Error codes are the stable API of the external CLI JSON. Never branch on the message text.
export const ERROR_SPECS = {
  // Arguments, schema, format
  E_INVALID_ARGUMENT: { exit: ExitCode.usage, retryable: false },
  E_UNSUPPORTED_FORMAT: { exit: ExitCode.usage, retryable: false },
  E_INVALID_SOURCE: { exit: ExitCode.usage, retryable: false },
  E_PARSE_FAILED: { exit: ExitCode.usage, retryable: false },
  E_CONFIRMATION_REQUIRED: { exit: ExitCode.usage, retryable: false },
  E_QUESTIONNAIRE_INVALID: { exit: ExitCode.usage, retryable: false },
  E_ANSWER_INVALID: { exit: ExitCode.usage, retryable: false },
  // Not found, not open
  E_PATH_NOT_FOUND: { exit: ExitCode.notFound, retryable: false },
  E_DOCUMENT_NOT_FOUND: { exit: ExitCode.notFound, retryable: false },
  E_DOCUMENT_NOT_OPEN: { exit: ExitCode.notFound, retryable: false },
  E_WATCH_NOT_FOUND: { exit: ExitCode.notFound, retryable: false },
  E_LINK_NOT_FOUND: { exit: ExitCode.notFound, retryable: false },
  E_SECTION_NOT_FOUND: { exit: ExitCode.notFound, retryable: false },
  E_REQUEST_NOT_FOUND: { exit: ExitCode.notFound, retryable: false },
  E_BROWSER_NOT_FOUND: { exit: ExitCode.notFound, retryable: false },
  // Conflicts, revision mismatches
  E_KEY_CONFLICT: { exit: ExitCode.conflict, retryable: false },
  E_REVISION_UNAVAILABLE: { exit: ExitCode.conflict, retryable: false },
  E_INVALID_CURSOR: { exit: ExitCode.conflict, retryable: false },
  E_CURSOR_STALE: { exit: ExitCode.conflict, retryable: false },
  E_CATALOG_CONFLICT: { exit: ExitCode.conflict, retryable: true },
  E_PENDING_REQUEST_EXISTS: { exit: ExitCode.conflict, retryable: false },
  E_OPERATION_CONFLICT: { exit: ExitCode.conflict, retryable: false },
  E_DRAFT_CONFLICT: { exit: ExitCode.conflict, retryable: false },
  E_SUBMISSION_CONFLICT: { exit: ExitCode.conflict, retryable: false },
  E_REQUEST_NOT_PENDING: { exit: ExitCode.conflict, retryable: false },
  E_REQUEST_PENDING: { exit: ExitCode.conflict, retryable: false },
  E_NOT_SUBMITTED: { exit: ExitCode.conflict, retryable: false },
  E_NEWER_REVISION: { exit: ExitCode.conflict, retryable: false },
  // Authorization, boundaries
  E_UNAUTHORIZED: { exit: ExitCode.forbidden, retryable: false },
  E_INSECURE_PATH: { exit: ExitCode.forbidden, retryable: false },
  E_ASSET_REJECTED: { exit: ExitCode.forbidden, retryable: false },
  E_INTERACTIVE_NOT_ALLOWED: { exit: ExitCode.forbidden, retryable: false },
  E_RENDER_GRANT_INVALID: { exit: ExitCode.forbidden, retryable: false },
  // Limits
  E_LIMIT_EXCEEDED: { exit: ExitCode.limit, retryable: false },
  E_MAX_BYTES_TOO_SMALL: { exit: ExitCode.limit, retryable: false },
  // Wait timeout
  E_TIMEOUT: { exit: ExitCode.timeout, retryable: true },
  // Interrupted by the user
  E_INTERRUPTED: { exit: ExitCode.interrupted, retryable: true },
  // Daemon startup, connection, compatibility
  E_DAEMON_UNAVAILABLE: { exit: ExitCode.daemon, retryable: true },
  E_DAEMON_START_FAILED: { exit: ExitCode.daemon, retryable: false },
  E_DAEMON_LOCKED: { exit: ExitCode.daemon, retryable: false },
  E_DAEMON_STOPPING: { exit: ExitCode.daemon, retryable: true },
  E_PROTOCOL_MISMATCH: { exit: ExitCode.daemon, retryable: false },
  E_UNKNOWN_METHOD: { exit: ExitCode.daemon, retryable: false },
  E_INDEX_NOT_READY: { exit: ExitCode.daemon, retryable: true },
  // I/O, state corruption, internal
  E_IO: { exit: ExitCode.internal, retryable: false },
  E_EXPORT_FAILED: { exit: ExitCode.internal, retryable: false },
  E_STORAGE_WRITE_FAILED: { exit: ExitCode.internal, retryable: true },
  E_COMMIT_INDETERMINATE: { exit: ExitCode.internal, retryable: true },
  E_STATE_CORRUPT: { exit: ExitCode.internal, retryable: false },
  E_STATE_FORMAT_UNSUPPORTED: { exit: ExitCode.internal, retryable: false },
  E_INTERNAL: { exit: ExitCode.internal, retryable: false },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_SPECS;

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_SPECS, value);
}

export function exitCodeForError(code: string): ExitCode {
  return isErrorCode(code) ? ERROR_SPECS[code].exit : ExitCode.internal;
}

export class VdeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VdeError';
    this.code = code;
    this.details = details;
    this.retryable = options.retryable ?? ERROR_SPECS[code].retryable;
  }
}

export function isVdeError(value: unknown): value is VdeError {
  return value instanceof VdeError;
}
