import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test stand-in for Tailscale Serve (ADR-0017): the browser reaches https://<HOST>:<port> through an HTTP proxy
// (CONNECT), a local TLS server ends HTTPS and forwards to the daemon's local socket, keeping Host and adding the
// identity header. A Tailscale-* header sent by the browser is never passed on. The certificate is self-signed and
// made per run; browsers check CSP, CORS, Host, Origin, and the same-origin policy as usual.
export const MOBILE_HOST = 'example-mac.example-tailnet.ts.net';
export const MOBILE_LOGIN = 'person@example.com';
export const MOBILE_UI_PORT = 43182;
export const MOBILE_PREVIEW_PORT = 43183;
export const MOBILE_UI_URL = `https://${MOBILE_HOST}:${String(MOBILE_UI_PORT)}/`;

export type Identity = 'person' | 'other' | 'none';

export interface MobileProxy {
  // The proxy for the phone's browser context.
  readonly server: string;
  // Who the forwarded requests come from.
  identity: Identity;
  close(): Promise<void>;
}

function certificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'vde-open-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${MOBILE_HOST}`,
        '-addext',
        `subjectAltName=DNS:${MOBILE_HOST}`,
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

// local(): the daemon's current local ports (they change when the daemon restarts in test mode).
export async function startMobileProxy(
  local: () => Promise<{ ui: number; preview: number }>,
): Promise<MobileProxy> {
  const tls = certificate();
  const proxy: MobileProxy = { server: '', identity: 'person', close: async () => undefined };
  const forward = (which: 'ui' | 'preview') =>
    createHttpsServer(tls, (incoming, outgoing) => {
      const headers = { ...incoming.headers };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase().startsWith('tailscale-')) delete headers[name];
      }
      if (proxy.identity === 'person') headers['tailscale-user-login'] = MOBILE_LOGIN;
      if (proxy.identity === 'other') headers['tailscale-user-login'] = 'someone@example.com';
      void local().then(
        (ports) => {
          const upstream = httpRequest(
            {
              host: '127.0.0.1',
              port: ports[which],
              method: incoming.method,
              path: incoming.url,
              headers,
            },
            (response) => {
              outgoing.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(outgoing);
            },
          );
          upstream.on('error', () => outgoing.destroy());
          incoming.pipe(upstream);
          outgoing.on('close', () => upstream.destroy());
        },
        () => outgoing.destroy(),
      );
    });
  const ui = forward('ui');
  const preview = forward('preview');
  const tlsPorts = { ui: await listen(ui), preview: await listen(preview) };
  const tunnel = createHttpServer((_request, response) => {
    response.writeHead(405).end();
  });
  // Only the two public origins of the phone reader are reachable through this proxy.
  tunnel.on('connect', (request, socket, head) => {
    const target =
      request.url === `${MOBILE_HOST}:${String(MOBILE_UI_PORT)}`
        ? tlsPorts.ui
        : request.url === `${MOBILE_HOST}:${String(MOBILE_PREVIEW_PORT)}`
          ? tlsPorts.preview
          : null;
    if (target === null) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(target, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  const tunneled = new Set<{ destroy(): void }>();
  tunnel.on('connect', (_request, socket) => {
    tunneled.add(socket);
    socket.on('close', () => tunneled.delete(socket));
  });
  const tunnelPort = await listen(tunnel);
  Object.assign(proxy, {
    server: `http://127.0.0.1:${String(tunnelPort)}`,
    close: async () => {
      for (const socket of tunneled) socket.destroy();
      for (const server of [tunnel, ui, preview]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  });
  return proxy;
}
