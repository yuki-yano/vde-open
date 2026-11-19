import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { VdeError, type DaemonStatus } from '@vde-open/shared';

import {
  DEFAULT_PORTS,
  LISTENER_CONFIG_FILE,
  readListenerConfig,
  resolveMobileConfig,
  resolvePcPorts,
  type MobileSettings,
} from '../daemon/listener-config.ts';
import { ensurePrivateDirectory } from '../daemon/secure-dir.ts';
import { resolveStateRoot, type PathEnvironment } from '../persistence/paths.ts';

// `vo mobile enable | disable | status` (ADR-0017): fill in the phone reader's settings from this machine's Tailscale
// and add or remove the two Serve forwards. Only forwards to this reader's own local ports are ever added or removed;
// anything else on those ports stops the command untouched.

const TAILSCALE_TIMEOUT_MS = 15_000;
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export interface Tailscale {
  // stdout of `tailscale <args>`. Fails with E_TAILSCALE_UNAVAILABLE or E_TAILSCALE_FAILED.
  run(args: string[]): Promise<string>;
}

function execute(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env, timeout: TAILSCALE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new VdeError('E_TAILSCALE_UNAVAILABLE', 'The tailscale command was not found.'));
          return;
        }
        // The CLI prints a version-mismatch warning first; the reason is on another line.
        const reason =
          stderr
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line !== '' && !line.startsWith('Warning:')) ?? 'failed';
        reject(
          new VdeError('E_TAILSCALE_FAILED', `tailscale ${args.join(' ')} failed: ${reason}`, {
            reason,
          }),
        );
      },
    );
  });
}

// `tailscale` on PATH, or the macOS app's CLI. VDE_OPEN_TAILSCALE (an absolute path) chooses it explicitly.
export function createTailscale(env: NodeJS.ProcessEnv): Tailscale {
  const explicit = env['VDE_OPEN_TAILSCALE'];
  if (explicit !== undefined && explicit !== '' && !isAbsolute(explicit)) {
    throw new VdeError('E_INVALID_ARGUMENT', 'VDE_OPEN_TAILSCALE must be an absolute path.');
  }
  const candidates = explicit ? [explicit] : ['tailscale', MAC_APP_CLI];
  return {
    async run(args) {
      let last: unknown = null;
      for (const command of candidates) {
        try {
          return await execute(command, args, env);
        } catch (error) {
          last = error;
          if (!(error instanceof VdeError && error.code === 'E_TAILSCALE_UNAVAILABLE')) throw error;
        }
      }
      throw last;
    },
  };
}

interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string; UserID?: number; Tags?: string[] };
  User?: Record<string, { LoginName?: string }>;
}

// This machine's full DNS name and the login of the person signed in to Tailscale here.
export async function detectIdentity(
  tailscale: Tailscale,
): Promise<{ host: string; login: string }> {
  const status = JSON.parse(await tailscale.run(['status', '--json'])) as TailscaleStatus;
  if (status.BackendState !== 'Running') {
    throw new VdeError(
      'E_TAILSCALE_FAILED',
      'Tailscale is not running or not signed in on this machine.',
      { reason: status.BackendState ?? 'unknown' },
    );
  }
  if ((status.Self?.Tags ?? []).length > 0) {
    // Serve adds no person's identity for a tagged device, so the reader could not tell who is reading.
    throw new VdeError(
      'E_TAILSCALE_FAILED',
      'This machine is a tagged device; Tailscale Serve sends no login for it, so the phone reader cannot be used.',
      { reason: 'tagged' },
    );
  }
  const host = (status.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
  const login = status.User?.[String(status.Self?.UserID)]?.LoginName ?? '';
  if (host === '' || login === '') {
    throw new VdeError(
      'E_TAILSCALE_FAILED',
      'Tailscale did not report this machine’s name or login.',
      {
        reason: 'incomplete-status',
      },
    );
  }
  return { host, login };
}

interface ServeStatus {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

export type ForwardState = 'free' | 'ours' | 'other';

// What Serve does with an HTTPS port of this machine: nothing, exactly this reader's forward, or anything else
// (another target, more paths, a TCP forward, or Funnel, which would publish it on the internet).
export function forwardState(serve: ServeStatus, host: string, port: number): ForwardState {
  const key = `${host}:${String(port)}`;
  const web = Object.entries(serve.Web ?? {}).filter(([name]) => name.endsWith(`:${String(port)}`));
  const handlers = serve.Web?.[key]?.Handlers ?? {};
  const ours =
    web.length === 1 &&
    web[0]?.[0] === key &&
    Object.keys(handlers).length === 1 &&
    handlers['/']?.Proxy === `http://127.0.0.1:${String(port)}` &&
    serve.AllowFunnel?.[key] !== true;
  if (ours) return 'ours';
  return web.length === 0 && serve.TCP?.[String(port)] === undefined ? 'free' : 'other';
}

async function serveStatus(tailscale: Tailscale): Promise<ServeStatus> {
  const text = (await tailscale.run(['serve', 'status', '--json'])).trim();
  return text === '' ? {} : (JSON.parse(text) as ServeStatus);
}

// listeners.json as a plain object, or an empty one when there is none.
async function readConfig(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new VdeError(
      'E_INVALID_ARGUMENT',
      `${LISTENER_CONFIG_FILE} is not a JSON object. Fix or remove it first.`,
      { path },
    );
  }
  return value as Record<string, unknown>;
}

async function writeConfig(path: string, config: Record<string, unknown>): Promise<void> {
  if (Object.keys(config).length === 0) {
    await rm(path, { force: true });
    return;
  }
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

// Whether Serve still has this reader's forward (`/` on that HTTPS port to the same local port), alone or not.
function hasReaderForward(serve: ServeStatus, host: string, port: number): boolean {
  return (
    serve.Web?.[`${host}:${String(port)}`]?.Handlers?.['/']?.Proxy ===
    `http://127.0.0.1:${String(port)}`
  );
}

// Remove the forwards this run added. Serve is read again right before each removal, and only a port that is exactly
// this reader's goes. Returns the ports where the reader's forward may still be: Serve could not be read, removing
// failed, or something else was added to the port meanwhile so it is not this command's to remove.
async function takeBack(tailscale: Tailscale, host: string, ports: number[]): Promise<number[]> {
  const left: number[] = [];
  for (const port of ports) {
    let status: ServeStatus;
    try {
      status = await serveStatus(tailscale);
    } catch {
      left.push(port);
      continue;
    }
    const state = forwardState(status, host, port);
    if (state !== 'ours') {
      if (hasReaderForward(status, host, port)) left.push(port);
      continue;
    }
    try {
      await tailscale.run(['serve', `--https=${String(port)}`, 'off']);
    } catch {
      left.push(port);
    }
  }
  return left;
}

export interface MobileSetupContext {
  environment: PathEnvironment;
  tailscale: Tailscale;
  // Stop the daemon if it runs, start it, and return its status (the settings apply on start).
  restartDaemon(): Promise<DaemonStatus>;
}

export interface EnableResult {
  uiUrl: string;
  host: string;
  login: string;
  serve: Record<string, 'added' | 'present' | 'skipped'>;
}

export async function enableMobile(
  context: MobileSetupContext,
  options: { serve: boolean },
): Promise<EnableResult> {
  const stateRoot = resolveStateRoot(context.environment);
  const path = join(stateRoot, LISTENER_CONFIG_FILE);
  const { host, login } = await detectIdentity(context.tailscale);
  // The daemon's own reading of the file first: settings it would refuse never get as far as stopping it.
  const pc = resolvePcPorts({}, await readListenerConfig(stateRoot), false);
  const config = await readConfig(path);
  const previous = (config['mobile'] ?? {}) as Partial<MobileSettings>;
  const portOr = (value: unknown, fallback: number) =>
    typeof value === 'number' ? value : fallback;
  const mobile = {
    host,
    login,
    uiPort: portOr(previous.uiPort, DEFAULT_PORTS.mobileUi),
    previewPort: portOr(previous.previewPort, DEFAULT_PORTS.mobilePreview),
  };
  const checked = resolveMobileConfig(mobile, pc);
  if (checked.state !== 'enabled') {
    throw new VdeError(
      'E_INVALID_ARGUMENT',
      `The phone reader settings are invalid (${checked.state === 'error' ? checked.reason : 'disabled'}).`,
    );
  }
  const ports = [mobile.uiPort, mobile.previewPort];

  // Look at Serve before changing anything: a port used for something else stops here, untouched.
  let before: ServeStatus = {};
  if (options.serve) {
    before = await serveStatus(context.tailscale);
    const taken = ports.filter((port) => forwardState(before, host, port) === 'other');
    if (taken.length > 0) {
      throw new VdeError(
        'E_SERVE_CONFLICT',
        `Tailscale Serve already uses HTTPS port ${taken.join(' and ')} for something else. Nothing was changed; free the port or choose other ports in ${LISTENER_CONFIG_FILE}.`,
        { ports: taken },
      );
    }
  }

  await ensurePrivateDirectory(stateRoot, {
    uid: context.environment.uid,
    platform: context.environment.platform,
  });
  await writeConfig(path, { ...config, mobile });
  const status = await context.restartDaemon();
  if (status.mobile?.state !== 'ready') {
    const reason = status.mobile?.state === 'error' ? `${status.mobile.reason}` : 'not started';
    throw new VdeError(
      'E_DAEMON_START_FAILED',
      `The settings were saved, but the phone reader did not start (${reason}). Serve was not changed.`,
      { mobile: status.mobile },
    );
  }

  const serve: EnableResult['serve'] = {};
  // Ports this run tried to forward (including one whose command failed: it may have applied anyway).
  const attempted: number[] = [];
  try {
    for (const port of ports) {
      if (!options.serve) {
        serve[String(port)] = 'skipped';
        continue;
      }
      // Checked again right before each change, so a forward made meanwhile is not overwritten. (The tailscale CLI
      // has no conditional update; this keeps the window to one command.)
      const now = forwardState(await serveStatus(context.tailscale), host, port);
      if (now === 'ours') {
        serve[String(port)] = 'present';
        continue;
      }
      if (now === 'other') {
        throw new VdeError(
          'E_SERVE_CONFLICT',
          `Tailscale Serve started using HTTPS port ${String(port)} for something else meanwhile.`,
          { ports: [port] },
        );
      }
      attempted.push(port);
      await context.tailscale.run([
        'serve',
        '--bg',
        `--https=${String(port)}`,
        `http://127.0.0.1:${String(port)}`,
      ]);
      serve[String(port)] = 'added';
    }
    if (attempted.length > 0) {
      const after = await serveStatus(context.tailscale);
      const missing = attempted.filter((port) => forwardState(after, host, port) !== 'ours');
      if (missing.length > 0) {
        throw new VdeError(
          'E_TAILSCALE_FAILED',
          `Serve does not show the forward for port ${missing.join(' and ')}.`,
          { reason: 'not-applied' },
        );
      }
    }
  } catch (error) {
    // Leave no half: take back what this run forwarded, if it is still exactly this reader's.
    const left = await takeBack(context.tailscale, host, attempted);
    throw new VdeError(
      error instanceof VdeError ? error.code : 'E_TAILSCALE_FAILED',
      `${error instanceof Error ? error.message : 'Serve could not be changed.'} The settings were saved in ${path}${
        left.length > 0
          ? `; Serve may still forward port ${left.join(' and ')} (check with vo mobile status).`
          : '; the forwards this run tried to add are no longer in Serve.'
      }`,
      {
        ...(error instanceof VdeError ? error.details : {}),
        settingsSaved: path,
        possiblyLeft: left,
      },
    );
  }
  return { uiUrl: status.mobile.uiUrl, host, login, serve };
}

export interface DisableResult {
  wasEnabled: boolean;
  serve: Record<string, 'removed' | 'absent' | 'kept' | 'skipped'>;
}

export async function disableMobile(
  context: MobileSetupContext & { daemonRunning(): Promise<boolean> },
  options: { serve: boolean },
): Promise<DisableResult> {
  const path = join(resolveStateRoot(context.environment), LISTENER_CONFIG_FILE);
  const config = await readConfig(path);
  const mobile = config['mobile'] as Partial<MobileSettings> | undefined;
  if (mobile === undefined) return { wasEnabled: false, serve: {} };
  const serve: DisableResult['serve'] = {};
  const ports = [
    mobile.uiPort ?? DEFAULT_PORTS.mobileUi,
    mobile.previewPort ?? DEFAULT_PORTS.mobilePreview,
  ];
  if (options.serve && typeof mobile.host === 'string') {
    for (const port of ports) {
      // Read right before each removal, so only a forward that is this reader's at that moment goes.
      const state = forwardState(await serveStatus(context.tailscale), mobile.host, port);
      if (state === 'ours') {
        await context.tailscale.run(['serve', `--https=${String(port)}`, 'off']);
        serve[String(port)] = 'removed';
      } else {
        // Something else on the port is not this reader's to remove.
        serve[String(port)] = state === 'free' ? 'absent' : 'kept';
      }
    }
  } else {
    for (const port of ports) serve[String(port)] = 'skipped';
  }
  const { mobile: _removed, ...rest } = config;
  await writeConfig(path, rest);
  if (await context.daemonRunning()) await context.restartDaemon();
  return { wasEnabled: true, serve };
}

export interface MobileStatusResult {
  configured: { host: string; login: string; uiPort: number; previewPort: number } | null;
  daemon: DaemonStatus['mobile'];
  serve: Record<string, ForwardState> | null;
  // The running reader's URL when Serve forwards both of its ports to it, else null.
  openableUrl: string | null;
}

export async function mobileStatus(
  context: Pick<MobileSetupContext, 'environment' | 'tailscale'> & {
    daemonStatus(): Promise<DaemonStatus>;
  },
): Promise<MobileStatusResult> {
  const config = await readConfig(
    join(resolveStateRoot(context.environment), LISTENER_CONFIG_FILE),
  );
  const mobile = config['mobile'] as Partial<MobileSettings> | undefined;
  const configured =
    mobile && typeof mobile.host === 'string' && typeof mobile.login === 'string'
      ? {
          host: mobile.host,
          login: mobile.login,
          uiPort: mobile.uiPort ?? DEFAULT_PORTS.mobileUi,
          previewPort: mobile.previewPort ?? DEFAULT_PORTS.mobilePreview,
        }
      : null;
  const daemon = (await context.daemonStatus()).mobile;
  // Serve is reported when Tailscale answers; without it the rest is still shown.
  const status =
    configured || daemon?.state === 'ready'
      ? await serveStatus(context.tailscale).catch(() => null)
      : null;
  const serve =
    configured && status
      ? {
          [String(configured.uiPort)]: forwardState(status, configured.host, configured.uiPort),
          [String(configured.previewPort)]: forwardState(
            status,
            configured.host,
            configured.previewPort,
          ),
        }
      : null;
  return { configured, daemon, serve, openableUrl: openableUrl(daemon, status) };
}

// The URL a phone can open right now: judged on the running reader (its normalized host and both of its ports), not
// on the saved settings, which may have changed since it started.
export function openableUrl(
  daemon: DaemonStatus['mobile'],
  serve: ServeStatus | null,
): string | null {
  if (daemon?.state !== 'ready' || serve === null) return null;
  const { hostname, port } = new URL(daemon.uiUrl);
  const forwarded = [Number(port), daemon.previewPort].every(
    (each) => forwardState(serve, hostname, each) === 'ours',
  );
  return forwarded ? daemon.uiUrl : null;
}
