import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

import { VdeError } from '@vde-open/shared';

// Where to look for a Chromium-based browser that prints the PDF. Nothing is installed or downloaded.
export interface BrowserLookup {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  isExecutable?: (path: string) => boolean;
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const MAC_APPS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_COMMANDS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
];

const WINDOWS_APPS = [
  'Google\\Chrome\\Application\\chrome.exe',
  'Microsoft\\Edge\\Application\\msedge.exe',
];

function candidates(lookup: BrowserLookup): string[] {
  const { env, platform, homeDir } = lookup;
  if (platform === 'darwin') {
    return ['/Applications', join(homeDir, 'Applications')].flatMap((dir) =>
      MAC_APPS.map((app) => join(dir, app)),
    );
  }
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']].filter(
      (root): root is string => root !== undefined && root !== '',
    );
    // Chrome first, then Edge, whichever install location they are in.
    return WINDOWS_APPS.flatMap((app) => roots.map((root) => `${root}\\${app}`));
  }
  const dirs = (env['PATH'] ?? '').split(delimiter).filter((dir) => isAbsolute(dir));
  return LINUX_COMMANDS.flatMap((command) => dirs.map((dir) => join(dir, command)));
}

// VDE_OPEN_BROWSER (an absolute path) selects the browser explicitly. Otherwise Google Chrome, Microsoft Edge and Chromium
// are looked for in the usual install locations (on Linux, on PATH). Looked up on every export, so a browser installed
// after the daemon started is used without a restart.
export function findBrowser(lookup: BrowserLookup): string {
  const isExecutable = lookup.isExecutable ?? executableFile;
  const explicit = lookup.env['VDE_OPEN_BROWSER'];
  if (explicit !== undefined && explicit !== '') {
    if (isAbsolute(explicit) && isExecutable(explicit)) return explicit;
    throw new VdeError(
      'E_BROWSER_NOT_FOUND',
      'VDE_OPEN_BROWSER is not the absolute path of an executable file.',
      { source: 'VDE_OPEN_BROWSER' },
    );
  }
  const found = candidates(lookup).find((path) => isExecutable(path));
  if (found !== undefined) return found;
  throw new VdeError(
    'E_BROWSER_NOT_FOUND',
    'Exporting a PDF needs Google Chrome or Microsoft Edge. Set VDE_OPEN_BROWSER to use another Chromium-based browser.',
    { source: 'search' },
  );
}
