import { ExitCode } from '@vde-open/shared';
import { Command, CommanderError } from 'commander';

import packageJson from '../../package.json' with { type: 'json' };

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const CLI_VERSION: string = packageJson.version;

// 表示名は呼び出し名（vde-open／vo）によらず固定する。両名の出力を一致させ、
// 呼び出し名からstateやdaemonの識別子を作らないため。
const PROGRAM_NAME = 'vde-open';

export function createProgram(io: CliIo): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description(
      '開いたMarkdown／HTMLをブラウザで表示し、Agentが一覧・検索・部分取得できるようにするローカルCLI',
    )
    .version(CLI_VERSION, '-V, --version', 'versionを表示する')
    .helpOption('-h, --help', 'helpを表示する')
    .addHelpText('after', '\n`vo`は`vde-open`と同じコマンドです。')
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .action(() => {
      io.stdout(program.helpInformation());
    });
  return program;
}

export async function runCli(argv: string[], io: CliIo): Promise<ExitCode> {
  const program = createProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? ExitCode.success : ExitCode.usage;
    }
    throw error;
  }
  return ExitCode.success;
}
