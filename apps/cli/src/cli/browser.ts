import { spawn } from 'node:child_process';

// 起動したcommandの終了を待つ上限。これを過ぎても動いていれば、起動できたものとして扱う。
const LAUNCH_WAIT_MS = 3000;

export interface BrowserLauncher {
  // 既定のbrowserでURLを開く。開けたらtrue。
  open(url: string): Promise<boolean>;
}

function launchCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  // BROWSERが指定されていれば、それを実行fileとして使う。shellの文字列としては解釈しない。
  const override = env['BROWSER'];
  if (override !== undefined && override !== '') return { command: override, args: [url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

export function createBrowserLauncher(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): BrowserLauncher {
  return {
    open(url) {
      return new Promise<boolean>((resolve) => {
        const { command, args } = launchCommand(env, platform, url);
        let settled = false;
        const settle = (opened: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(opened);
        };
        const child = spawn(command, args, { detached: true, stdio: 'ignore', env });
        const timer = setTimeout(() => settle(true), LAUNCH_WAIT_MS);
        child.on('error', () => settle(false));
        child.on('exit', (code) => settle(code === 0));
        child.unref();
      });
    },
  };
}
