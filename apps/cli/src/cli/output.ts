// Replace control characters that drive the terminal with a notation that does not execute (CLI-016).

function codeUnitEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

// JSON.stringify escapes U+0000 to U+001F but emits DEL and C1 control characters raw.
// Escape those too, preventing terminal control while keeping the JSON valid.
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, codeUnitEscape);
}

// For single-line values people read (title, path, etc.). Newlines and tabs also break the line, so they are escaped.
export function escapeForTerminal(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, codeUnitEscape);
}

// For writing document bodies to the terminal. Keeps newlines and tabs, escapes the other control characters.
export function escapeContentForTerminal(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, codeUnitEscape);
}
