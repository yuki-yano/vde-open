import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VdeError, type DaemonStatus } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PathEnvironment } from '../persistence/paths.ts';
import {
  detectIdentity,
  disableMobile,
  enableMobile,
  forwardState,
  type Tailscale,
} from './mobile-setup.ts';

const HOST = 'mac.example-tailnet.ts.net';

interface FakeServe {
  TCP: Record<string, unknown>;
  Web: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}
const otherForward = (serve: FakeServe, port: number) => {
  serve.TCP[String(port)] = { HTTPS: true };
  serve.Web[`${HOST}:${String(port)}`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } };
};
const LOGIN = 'person@example.com';

// An in-memory Tailscale: its status and Serve configuration, and every command run.
function fakeTailscale(
  options: {
    failAddOn?: number;
    // The add takes effect, then the command still fails (a timeout after applying).
    applyThenFailOn?: number;
    failOffOn?: number;
    tags?: string[];
    backend?: string;
    // Runs after the n-th `serve status` is answered (n from 1): another program changing Serve meanwhile.
    afterServeStatus?: (n: number, serve: FakeServe) => void;
  } = {},
) {
  let serveReads = 0;
  const calls: string[][] = [];
  const serve: FakeServe = { TCP: {}, Web: {} };
  const tailscale: Tailscale = {
    run(args) {
      calls.push(args);
      if (args[0] === 'status') {
        return Promise.resolve(
          JSON.stringify({
            BackendState: options.backend ?? 'Running',
            Self: {
              DNSName: `${HOST.toUpperCase()}.`,
              UserID: 7,
              ...(options.tags ? { Tags: options.tags } : {}),
            },
            User: { '7': { LoginName: LOGIN } },
          }),
        );
      }
      if (args[0] === 'serve' && args[1] === 'status') {
        const answer = JSON.stringify(serve);
        serveReads += 1;
        options.afterServeStatus?.(serveReads, serve);
        return Promise.resolve(answer);
      }
      const https = args.find((arg) => arg.startsWith('--https='));
      const port = https?.slice('--https='.length) ?? '';
      if (args.includes('off')) {
        if (Number(port) === options.failOffOn) {
          return Promise.reject(new VdeError('E_TAILSCALE_FAILED', 'failed', { reason: 'test' }));
        }
        delete serve.TCP[port];
        delete serve.Web[`${HOST}:${port}`];
        return Promise.resolve('');
      }
      if (Number(port) === options.failAddOn) {
        return Promise.reject(new VdeError('E_TAILSCALE_FAILED', 'failed', { reason: 'test' }));
      }
      serve.TCP[port] = { HTTPS: true };
      serve.Web[`${HOST}:${port}`] = { Handlers: { '/': { Proxy: args.at(-1) ?? '' } } };
      if (Number(port) === options.applyThenFailOn) {
        return Promise.reject(new VdeError('E_TAILSCALE_FAILED', 'timed out', { reason: 'test' }));
      }
      return Promise.resolve('');
    },
  };
  return { tailscale, calls, serve };
}

let base: string;
let environment: PathEnvironment;
let restarts: number;
const configPath = () => join(base, 'home', 'listeners.json');
const ready: DaemonStatus['mobile'] = { state: 'ready', uiUrl: `https://${HOST}:43182/` };
let mobileAfterRestart: DaemonStatus['mobile'];
const restartDaemon = () => {
  restarts += 1;
  return Promise.resolve({ mobile: mobileAfterRestart } as DaemonStatus);
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vde-open-mobile-setup-'));
  environment = {
    env: { VDE_OPEN_HOME: join(base, 'home') },
    platform: process.platform,
    homeDir: base,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  };
  restarts = 0;
  mobileAfterRestart = ready;
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('vo mobile enable', () => {
  it('fills in the name and login from Tailscale, keeps other settings, restarts the daemon, and adds both forwards', async () => {
    await mkdir(join(base, 'home'), { recursive: true, mode: 0o700 });
    await writeFile(
      configPath(),
      JSON.stringify({ managementPort: 5000, mobile: { uiPort: 44000 } }),
    );
    const { tailscale, calls } = fakeTailscale();
    const result = await enableMobile({ environment, tailscale, restartDaemon }, { serve: true });
    expect(result).toEqual({
      uiUrl: `https://${HOST}:43182/`,
      host: HOST,
      login: LOGIN,
      serve: { '44000': 'added', '43183': 'added' },
    });
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({
      managementPort: 5000,
      mobile: { host: HOST, login: LOGIN, uiPort: 44000, previewPort: 43183 },
    });
    expect((await stat(configPath())).mode & 0o777).toBe(0o600);
    expect(restarts).toBe(1);
    expect(calls).toContainEqual(['serve', '--bg', '--https=44000', 'http://127.0.0.1:44000']);
    expect(calls).toContainEqual(['serve', '--bg', '--https=43183', 'http://127.0.0.1:43183']);

    // Running it again changes nothing in Serve.
    const again = await enableMobile({ environment, tailscale, restartDaemon }, { serve: true });
    expect(again.serve).toEqual({ '44000': 'present', '43183': 'present' });
  });

  it('a port Serve uses for something else stops it before anything changes', async () => {
    const { tailscale, calls, serve } = fakeTailscale();
    serve.TCP['43183'] = { HTTPS: true };
    serve.Web[`${HOST}:43183`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } };
    await expect(
      enableMobile({ environment, tailscale, restartDaemon }, { serve: true }),
    ).rejects.toMatchObject({ code: 'E_SERVE_CONFLICT', details: { ports: [43183] } });
    await expect(readFile(configPath(), 'utf8')).rejects.toThrow();
    expect(restarts).toBe(0);
    expect(calls.filter((call) => call.includes('--bg'))).toEqual([]);
  });

  it('a forward opened to the internet (Funnel) counts as something else', () => {
    const serve = {
      TCP: { '43182': {} },
      Web: { [`${HOST}:43182`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:43182' } } } },
      AllowFunnel: { [`${HOST}:43182`]: true },
    };
    expect(forwardState(serve, HOST, 43182)).toBe('other');
    expect(forwardState({ ...serve, AllowFunnel: {} }, HOST, 43182)).toBe('ours');
    expect(forwardState({}, HOST, 43182)).toBe('free');
  });

  it('when the second forward fails, the first one added by this run is taken back', async () => {
    const { tailscale, serve } = fakeTailscale({ failAddOn: 43183 });
    await expect(
      enableMobile({ environment, tailscale, restartDaemon }, { serve: true }),
    ).rejects.toMatchObject({ code: 'E_TAILSCALE_FAILED' });
    expect(serve.Web).toEqual({});
  });

  it('when the daemon does not start the reader, Serve is not changed', async () => {
    mobileAfterRestart = { state: 'error', listener: 'ui', port: 43182, reason: 'EADDRINUSE' };
    const { tailscale, calls } = fakeTailscale();
    await expect(
      enableMobile({ environment, tailscale, restartDaemon }, { serve: true }),
    ).rejects.toMatchObject({ code: 'E_DAEMON_START_FAILED' });
    expect(calls.filter((call) => call.includes('--bg'))).toEqual([]);
  });

  it('--no-serve only writes the settings and restarts the daemon', async () => {
    const { tailscale, calls } = fakeTailscale();
    const result = await enableMobile({ environment, tailscale, restartDaemon }, { serve: false });
    expect(result.serve).toEqual({ '43182': 'skipped', '43183': 'skipped' });
    expect(calls.every((call) => call[0] === 'status')).toBe(true);
  });

  it.each([
    ['not running', { backend: 'Stopped' }],
    ['a tagged device (Serve sends no login)', { tags: ['tag:server'] }],
  ])('refuses when Tailscale is %s', async (_name, options) => {
    await expect(detectIdentity(fakeTailscale(options).tailscale)).rejects.toMatchObject({
      code: 'E_TAILSCALE_FAILED',
    });
  });
});

describe('vo mobile disable', () => {
  it('removes only its own forwards and the mobile settings, keeping the rest of the file', async () => {
    const { tailscale, serve } = fakeTailscale();
    await mkdir(join(base, 'home'), { recursive: true, mode: 0o700 });
    await writeFile(configPath(), JSON.stringify({ previewPort: 5001 }));
    await enableMobile({ environment, tailscale, restartDaemon }, { serve: true });
    // Someone pointed 43183 elsewhere since.
    serve.Web[`${HOST}:43183`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } };
    const result = await disableMobile(
      { environment, tailscale, restartDaemon, daemonRunning: () => Promise.resolve(true) },
      { serve: true },
    );
    expect(result).toEqual({ wasEnabled: true, serve: { '43182': 'removed', '43183': 'kept' } });
    expect(Object.keys(serve.Web)).toEqual([`${HOST}:43183`]);
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({ previewPort: 5001 });
  });

  it('removes the file when nothing else was in it', async () => {
    const { tailscale } = fakeTailscale();
    await enableMobile({ environment, tailscale, restartDaemon }, { serve: true });
    await disableMobile(
      { environment, tailscale, restartDaemon, daemonRunning: () => Promise.resolve(false) },
      { serve: true },
    );
    await expect(readFile(configPath(), 'utf8')).rejects.toThrow();
  });
});

describe('review follow-ups for vo mobile', () => {
  it('a forward made by another program after the first check is not overwritten, and what this run added is taken back', async () => {
    const { tailscale, serve, calls } = fakeTailscale({
      // After the up-front check, 43183 is taken for something else.
      afterServeStatus: (n, current) => {
        if (n === 1) otherForward(current, 43183);
      },
    });
    const failure = enableMobile({ environment, tailscale, restartDaemon }, { serve: true });
    await expect(failure).rejects.toMatchObject({
      code: 'E_SERVE_CONFLICT',
      details: { possiblyLeft: [], settingsSaved: configPath() },
    });
    expect(serve.Web).toEqual({
      [`${HOST}:43183`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } },
    });
    expect(calls).not.toContainEqual(['serve', '--bg', '--https=43183', 'http://127.0.0.1:43183']);
  });

  it('a forward that applied before its command failed is taken back too', async () => {
    const { tailscale, serve } = fakeTailscale({ applyThenFailOn: 43183 });
    await expect(
      enableMobile({ environment, tailscale, restartDaemon }, { serve: true }),
    ).rejects.toMatchObject({ details: { possiblyLeft: [] } });
    expect(serve.Web).toEqual({});
  });

  it('a take-back that fails names the port that may still be forwarded and where the settings were saved', async () => {
    const { tailscale } = fakeTailscale({ failAddOn: 43183, failOffOn: 43182 });
    const failure = await enableMobile(
      { environment, tailscale, restartDaemon },
      { serve: true },
    ).catch((error: unknown) => error as VdeError);
    expect(failure).toMatchObject({
      details: { possiblyLeft: [43182], settingsSaved: configPath() },
    });
    expect((failure as VdeError).message).toContain('may still forward port 43182');
  });

  it('PC settings the daemon would refuse stop it before the file changes or the daemon stops', async () => {
    await mkdir(join(base, 'home'), { recursive: true, mode: 0o700 });
    await writeFile(configPath(), JSON.stringify({ managementPort: 'x' }));
    const { tailscale } = fakeTailscale();
    await expect(
      enableMobile({ environment, tailscale, restartDaemon }, { serve: true }),
    ).rejects.toMatchObject({ details: { reason: 'listener-config' } });
    expect(restarts).toBe(0);
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({ managementPort: 'x' });
  });

  it('disable reads Serve right before each removal and keeps a forward that changed meanwhile', async () => {
    const { tailscale, serve } = fakeTailscale();
    await enableMobile({ environment, tailscale, restartDaemon }, { serve: true });
    let reads = 0;
    const watching: Tailscale = {
      run: async (args) => {
        const out = await tailscale.run(args);
        if (args[1] === 'status' && args[0] === 'serve') {
          reads += 1;
          // After 43182 was looked at, 43183 is pointed elsewhere.
          if (reads === 1) otherForward(serve, 43183);
        }
        return out;
      },
    };
    const result = await disableMobile(
      {
        environment,
        tailscale: watching,
        restartDaemon,
        daemonRunning: () => Promise.resolve(false),
      },
      { serve: true },
    );
    expect(result.serve).toEqual({ '43182': 'removed', '43183': 'kept' });
    expect(Object.keys(serve.Web)).toEqual([`${HOST}:43183`]);
  });

  it('the take-back reads Serve again before each removal: a port changed meanwhile is not removed', async () => {
    const { tailscale, serve } = fakeTailscale({ applyThenFailOn: 43183 });
    let offs = 0;
    const watching: Tailscale = {
      run: async (args) => {
        const out = await tailscale.run(args);
        if (args.includes('off')) {
          offs += 1;
          // While 43182 is being taken back, another program points 43183 elsewhere.
          if (offs === 1) otherForward(serve, 43183);
        }
        return out;
      },
    };
    await expect(
      enableMobile({ environment, tailscale: watching, restartDaemon }, { serve: true }),
    ).rejects.toMatchObject({ details: { possiblyLeft: [] } });
    expect(serve.Web).toEqual({
      [`${HOST}:43183`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } },
    });
  });

  it('a reader forward that another path was added beside is reported as possibly left, not removed', async () => {
    const { tailscale, serve } = fakeTailscale({ failAddOn: 43183 });
    const watching: Tailscale = {
      run: async (args) => {
        const out = await tailscale.run(args);
        if (args.includes('--https=43182') && args.includes('--bg')) {
          // Another program adds a second path to the port this run just forwarded.
          const added = serve.Web[`${HOST}:43182`];
          if (added) added.Handlers['/other'] = { Proxy: 'http://127.0.0.1:9999' };
        }
        return out;
      },
    };
    const failure = await enableMobile(
      { environment, tailscale: watching, restartDaemon },
      { serve: true },
    ).catch((error: unknown) => error as VdeError);
    expect(failure).toMatchObject({ details: { possiblyLeft: [43182] } });
    expect((failure as VdeError).message).toContain('may still forward port 43182');
    expect(Object.keys(serve.Web[`${HOST}:43182`]?.Handlers ?? {}).toSorted()).toEqual([
      '/',
      '/other',
    ]);
  });
});
