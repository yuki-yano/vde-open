// Delegate top-level file arguments to open (spec 5.1).
// If the first positional argument is not a known subcommand, prepend `open`.

export interface ArgvRules {
  subcommands: ReadonlySet<string>;
  // Options of open that take a value (for example --title). Used so the value is not mistaken for a positional argument.
  valueOptions: ReadonlySet<string>;
}

export function normalizeArgv(argv: string[], stdinIsPiped: boolean, rules: ArgvRules): string[] {
  let firstPositional: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    // After `--`, even a token named like a subcommand is a file. `-` means stdin.
    if (token === '--' || token === '-') return ['open', ...argv];
    if (token.startsWith('-')) {
      // In `--title read`, read is the option value. `--title=read` is a single token, so nothing is skipped.
      if (rules.valueOptions.has(token)) index += 1;
      continue;
    }
    firstPositional = token;
    break;
  }
  if (firstPositional !== undefined) {
    return rules.subcommands.has(firstPositional) ? argv : ['open', ...argv];
  }
  const asksForInfo = argv.some((token) => ['-h', '--help', '-V', '--version'].includes(token));
  // With no positional argument and a piped stdin, open from stdin.
  if (stdinIsPiped && !asksForInfo) return ['open', ...argv];
  return argv;
}
