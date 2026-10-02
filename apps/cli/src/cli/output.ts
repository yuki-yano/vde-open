// 端末を操作する制御文字を、実行されない表記へ置き換える（CLI-016）。

function codeUnitEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

// JSON.stringifyはU+0000〜U+001Fをescapeするが、DELとC1制御文字は生のまま出す。
// それらもescapeして、JSONとして正しいまま端末制御を防ぐ。
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, codeUnitEscape);
}

// 人が読む1行の値（title、pathなど）に使う。改行やtabも1行を壊すのでescapeする。
export function escapeForTerminal(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, codeUnitEscape);
}

// 本文を端末へ出すときに使う。改行とtabは残し、それ以外の制御文字をescapeする。
export function escapeContentForTerminal(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, codeUnitEscape);
}
