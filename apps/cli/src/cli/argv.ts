// 最上位のfile引数をopenへ委譲する（仕様5.1）。
// 最初の位置引数が既知のsubcommandでなければ、先頭に`open`を補う。

export interface ArgvRules {
  subcommands: ReadonlySet<string>;
  // openのoptionのうち、値を取るもの（例: --title）。値を位置引数と取り違えないために使う。
  valueOptions: ReadonlySet<string>;
}

export function normalizeArgv(argv: string[], stdinIsPiped: boolean, rules: ArgvRules): string[] {
  let firstPositional: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    // `--`の後は、subcommandと同名でもfileとして扱う。`-`はstdinの指定。
    if (token === '--' || token === '-') return ['open', ...argv];
    if (token.startsWith('-')) {
      // `--title read`のreadはoptionの値。`--title=read`は1つのtokenなので読み飛ばさない。
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
  // 位置引数がなく、stdinがpipeなら、stdinから開く。
  if (stdinIsPiped && !asksForInfo) return ['open', ...argv];
  return argv;
}
