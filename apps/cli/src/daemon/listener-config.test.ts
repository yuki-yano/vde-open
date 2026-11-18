import { describe, expect, it } from 'vitest';

import { resolveMobileConfig } from './listener-config.ts';

const PC = { management: 43180, preview: 43181 };
const base = { host: 'Example-Mac.Example-Tailnet.ts.net.', login: 'person@example.com' };

describe('the mobile section of listeners.json', () => {
  it('is off when absent, and normalizes the host with the default ports', () => {
    expect(resolveMobileConfig(undefined, PC)).toEqual({ state: 'disabled' });
    expect(resolveMobileConfig(base, PC)).toEqual({
      state: 'enabled',
      settings: {
        host: 'example-mac.example-tailnet.ts.net',
        login: 'person@example.com',
        uiPort: 43182,
        previewPort: 43183,
      },
    });
  });

  it.each([
    ['a scheme', { host: 'https://mac.example.ts.net' }, 'invalid:mobile.host'],
    ['a port', { host: 'mac.example.ts.net:443' }, 'invalid:mobile.host'],
    ['a path', { host: 'mac.example.ts.net/x' }, 'invalid:mobile.host'],
    ['user info', { host: 'me@mac.example.ts.net' }, 'invalid:mobile.host'],
    ['a single label', { host: 'mac' }, 'invalid:mobile.host'],
    ['a login with a comma', { login: 'a@example.com,b@example.com' }, 'invalid:mobile.login'],
    ['a login with a space', { login: 'a person' }, 'invalid:mobile.login'],
    ['a non-ASCII login', { login: 'ひと@example.com' }, 'invalid:mobile.login'],
    ['no login', { login: undefined }, 'invalid:mobile.login'],
    ['a port out of range', { uiPort: 70000 }, 'invalid:mobile.uiPort'],
    ['the default HTTPS port', { previewPort: 443 }, 'invalid:mobile.previewPort'],
    ['an unknown key', { extra: true }, 'invalid:mobile'],
    ['the same port twice', { uiPort: 5000, previewPort: 5000 }, 'duplicate-port'],
    ['a PC port', { previewPort: 43180 }, 'duplicate-port'],
  ])('with %s is an error that leaves the PC alone', (_name, change, reason) => {
    expect(resolveMobileConfig({ ...base, ...change }, PC)).toEqual({ state: 'error', reason });
  });

  it('in test mode, PC ports assigned by the OS (0) never collide', () => {
    expect(resolveMobileConfig(base, { management: 0, preview: 0 }).state).toBe('enabled');
  });
});
