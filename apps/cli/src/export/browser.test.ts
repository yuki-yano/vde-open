import { describe, expect, it } from 'vitest';

import { findBrowser, type BrowserLookup } from './browser.ts';

const lookup = (
  platform: NodeJS.Platform,
  installed: string[],
  env: NodeJS.ProcessEnv = {},
): BrowserLookup => ({
  env,
  platform,
  homeDir: '/Users/me',
  isExecutable: (path) => installed.includes(path),
});

describe('finding the browser that prints the PDF', () => {
  it('on macOS, takes Chrome, then Edge, then Chromium, from /Applications and then ~/Applications', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const userChrome = '/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    expect(findBrowser(lookup('darwin', [edge, chrome]))).toBe(chrome);
    expect(findBrowser(lookup('darwin', [edge, userChrome]))).toBe(edge);
    expect(findBrowser(lookup('darwin', [userChrome]))).toBe(userChrome);
  });

  it('on Linux, looks for the commands on PATH, Chrome first', () => {
    const env = { PATH: '/usr/local/bin:relative/bin:/usr/bin' };
    expect(
      findBrowser(lookup('linux', ['/usr/bin/microsoft-edge', '/usr/bin/chromium'], env)),
    ).toBe('/usr/bin/chromium');
    expect(findBrowser(lookup('linux', ['/usr/bin/google-chrome-stable'], env))).toBe(
      '/usr/bin/google-chrome-stable',
    );
    // A relative PATH entry is never used.
    expect(() => findBrowser(lookup('linux', ['relative/bin/google-chrome'], env))).toThrow();
  });

  it('on Windows, looks in Program Files and the local application data, Chrome before Edge', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    };
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const userChrome = 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    expect(findBrowser(lookup('win32', [edge, userChrome], env))).toBe(userChrome);
    expect(findBrowser(lookup('win32', [edge], env))).toBe(edge);
  });

  it('uses only VDE_OPEN_BROWSER when it is set, and only as an absolute path to an executable', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    expect(findBrowser(lookup('darwin', [chrome, brave], { VDE_OPEN_BROWSER: brave }))).toBe(brave);
    expect(() =>
      findBrowser(lookup('darwin', [chrome], { VDE_OPEN_BROWSER: '/missing/browser' })),
    ).toThrow(
      expect.objectContaining({
        code: 'E_BROWSER_NOT_FOUND',
        details: { source: 'VDE_OPEN_BROWSER' },
      }),
    );
    expect(() => findBrowser(lookup('darwin', ['brave'], { VDE_OPEN_BROWSER: 'brave' }))).toThrow(
      expect.objectContaining({ code: 'E_BROWSER_NOT_FOUND' }),
    );
  });

  it('reports that no browser was found', () => {
    expect(() => findBrowser(lookup('darwin', []))).toThrow(
      expect.objectContaining({ code: 'E_BROWSER_NOT_FOUND', details: { source: 'search' } }),
    );
  });
});
