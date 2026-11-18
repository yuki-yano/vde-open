import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { VdeError } from '@vde-open/shared';
import { z } from 'zod';

import type { PathEnvironment } from '../persistence/paths.ts';

export const LISTENER_CONFIG_FILE = 'listeners.json';

export const DEFAULT_PORTS = {
  management: 43180,
  preview: 43181,
  mobileUi: 43182,
  mobilePreview: 43183,
} as const;

const portSchema = z.number().int().min(1).max(65535);

// The PC part is strict. `mobile` is kept as is and validated on its own, so a broken mobile section never stops the PC.
const pcConfigSchema = z.strictObject({
  managementPort: portSchema.optional(),
  previewPort: portSchema.optional(),
  mobile: z.unknown().optional(),
});

export interface ListenerConfig {
  managementPort?: number;
  previewPort?: number;
  // Raw `mobile` section, if present.
  mobile?: unknown;
}

function configError(path: string, reason: string, message: string): VdeError {
  return new VdeError('E_DAEMON_START_FAILED', `${message} (${path})`, {
    reason: 'listener-config',
    path,
    issue: reason,
  });
}

// Read `listeners.json` under the state root. A missing file means the defaults.
// A file that exists but cannot be read, is not JSON, or has an invalid PC part is a start error.
export async function readListenerConfig(stateRoot: string): Promise<ListenerConfig> {
  const path = join(stateRoot, LISTENER_CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only a missing entry means "no settings". A link whose target is gone, or an entry that cannot be inspected,
    // is a broken setting.
    if (code === 'ENOENT') {
      const entry = await lstat(path).then(
        () => 'present',
        (inspect: NodeJS.ErrnoException) => inspect.code ?? 'unreadable',
      );
      if (entry === 'ENOENT') return {};
    }
    throw configError(path, code ?? 'unreadable', 'The listener settings could not be read.');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw configError(path, 'json', 'The listener settings are not valid JSON.');
  }
  const parsed = pcConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'root';
    throw configError(path, `invalid:${where}`, `The listener settings are invalid at ${where}.`);
  }
  // Duplicate ports are checked after merging with the start arguments (resolvePcPorts).
  return parsed.data;
}

// Test and development runs with an explicit absolute VDE_OPEN_HOME may let the OS assign unspecified ports.
// Never applies to the normal state root, so the production URL stays fixed.
export function ephemeralPortsAllowed(environment: PathEnvironment): boolean {
  const home = environment.env['VDE_OPEN_HOME'];
  return (
    environment.env['VDE_OPEN_TEST_EPHEMERAL_PORTS'] === '1' &&
    home !== undefined &&
    home !== '' &&
    isAbsolute(home)
  );
}

export interface PcPorts {
  // 0 lets the OS assign the port.
  management: number;
  preview: number;
}

// Explicit start arguments win over the settings file, which wins over the defaults. Arguments are never written back.
export function resolvePcPorts(
  explicit: { managementPort?: number | undefined; previewPort?: number | undefined },
  config: ListenerConfig,
  ephemeral: boolean,
): PcPorts {
  const pick = (
    argument: number | undefined,
    configured: number | undefined,
    fallback: number,
  ): number => argument ?? configured ?? (ephemeral ? 0 : fallback);
  const ports = {
    management: pick(explicit.managementPort, config.managementPort, DEFAULT_PORTS.management),
    preview: pick(explicit.previewPort, config.previewPort, DEFAULT_PORTS.preview),
  };
  if (ports.management !== 0 && ports.management === ports.preview) {
    throw new VdeError(
      'E_DAEMON_START_FAILED',
      `The management and preview listeners cannot share port ${String(ports.management)}.`,
      { reason: 'duplicate-port', port: ports.management },
    );
  }
  return ports;
}

// The phone reader's settings (ADR-0017). Tailscale Serve forwards https://<host>:<port> to the same port on 127.0.0.1.
export interface MobileSettings {
  // Lowercase full DNS name of the Mac in the tailnet.
  host: string;
  // The Tailscale login of the one person allowed to read (exact match of Tailscale-User-Login).
  login: string;
  uiPort: number;
  previewPort: number;
}

export type MobileConfig =
  | { state: 'disabled' }
  | { state: 'enabled'; settings: MobileSettings }
  | { state: 'error'; reason: string };

const mobilePortSchema = portSchema.refine((port) => port !== 443, 'must not be 443');

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_NAME = new RegExp(`^(?=.{1,253}$)${DNS_LABEL}(?:\\.${DNS_LABEL})+$`);

const mobileSchema = z.strictObject({
  host: z
    .string()
    .transform((value) => value.toLowerCase().replace(/\.$/, ''))
    .refine(
      (value) => DNS_NAME.test(value),
      'must be a full DNS name without scheme, port, or path',
    ),
  // ASCII without spaces, commas, or control characters, so one header value matches it exactly.
  login: z.string().regex(/^[!-+\--~]{1,256}$/, 'must be an ASCII login name'),
  // Not 443: browsers drop the default HTTPS port from Host and Origin, so the exact match would never hold.
  uiPort: mobilePortSchema.default(DEFAULT_PORTS.mobileUi),
  previewPort: mobilePortSchema.default(DEFAULT_PORTS.mobilePreview),
});

// A broken mobile section disables only the phone reader; the PC keeps running and reports why.
export function resolveMobileConfig(raw: unknown, pcPorts: PcPorts): MobileConfig {
  if (raw === undefined) return { state: 'disabled' };
  const parsed = mobileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `mobile.${issue.path.join('.')}` : 'mobile';
    return { state: 'error', reason: `invalid:${where}` };
  }
  const settings = parsed.data;
  const taken = [pcPorts.management, pcPorts.preview].filter((port) => port !== 0);
  if (
    settings.uiPort === settings.previewPort ||
    taken.includes(settings.uiPort) ||
    taken.includes(settings.previewPort)
  ) {
    return { state: 'error', reason: 'duplicate-port' };
  }
  return { state: 'enabled', settings };
}
