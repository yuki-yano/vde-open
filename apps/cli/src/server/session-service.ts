import { createHash, randomBytes } from 'node:crypto';

import { LIMITS } from '@vde-open/shared';

function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export interface SessionService {
  // One-time ticket for opening the browser. Valid for 60 seconds.
  createBootstrapTicket(): string;
  // Exchanges a ticket for a session token. Used, expired, or unknown tickets yield null.
  exchange(ticket: string): string | null;
  authenticate(token: string): boolean;
  // Whether the session is active. Does not update the last-used time (keeping a connection open does not extend the expiry).
  isActive(token: string): boolean;
  revoke(token: string): void;
  // Called when the session is revoked. Used to close connections left open. The return value unsubscribes.
  onRevoke(token: string, listener: () => void): () => void;
  // Non-secret identifier for a session. Used to bind grants to a session without holding the token.
  idOf(token: string): string;
  // Whether the session the identifier refers to is active. Does not update the last-used time.
  isActiveId(sessionId: string): boolean;
  // Called with the identifier whenever any session is revoked.
  onAnyRevoke(listener: (sessionId: string) => void): void;
  // Number of retained entries (used to check for resource leaks. daemon.diagnostics).
  retainedCounts(): Record<string, number>;
}

// Handles browser management sessions (spec 6.4). Secrets themselves are not kept; digests are compared.
// Kept in memory only, so everything expires when the daemon restarts.
export function createSessionService(now: () => number = Date.now): SessionService {
  const tickets = new Map<string, number>();
  const sessions = new Map<string, number>();
  const revokeListeners = new Map<string, Set<() => void>>();
  const anyRevokeListeners = new Set<(sessionId: string) => void>();

  const drop = (key: string) => {
    if (!sessions.delete(key)) return;
    const listeners = revokeListeners.get(key);
    revokeListeners.delete(key);
    if (listeners) for (const listener of listeners) listener();
    for (const listener of anyRevokeListeners) listener(key);
  };

  const isActiveKey = (key: string): boolean => {
    const lastUsedAt = sessions.get(key);
    if (lastUsedAt === undefined) return false;
    if (lastUsedAt + LIMITS.sessionIdleMs < now()) {
      drop(key);
      return false;
    }
    return true;
  };

  const sweep = () => {
    const current = now();
    for (const [key, expiresAt] of tickets) if (expiresAt < current) tickets.delete(key);
    for (const [key, lastUsedAt] of sessions) {
      if (lastUsedAt + LIMITS.sessionIdleMs < current) drop(key);
    }
  };

  return {
    retainedCounts() {
      let listeners = 0;
      for (const set of revokeListeners.values()) listeners += set.size;
      return {
        tickets: tickets.size,
        sessions: sessions.size,
        revokeListeners: listeners,
        anyRevokeListeners: anyRevokeListeners.size,
      };
    },
    createBootstrapTicket() {
      sweep();
      const ticket = newSecret();
      tickets.set(digest(ticket), now() + LIMITS.bootstrapTicketTtlMs);
      return ticket;
    },
    exchange(ticket) {
      sweep();
      const key = digest(ticket);
      const expiresAt = tickets.get(key);
      // Whether it succeeds or not, the same ticket cannot be used twice.
      tickets.delete(key);
      if (expiresAt === undefined || expiresAt < now()) return null;
      const token = newSecret();
      sessions.set(digest(token), now());
      return token;
    },
    authenticate(token) {
      const key = digest(token);
      const lastUsedAt = sessions.get(key);
      if (lastUsedAt === undefined) return false;
      if (lastUsedAt + LIMITS.sessionIdleMs < now()) {
        drop(key);
        return false;
      }
      sessions.set(key, now());
      return true;
    },
    isActive: (token) => isActiveKey(digest(token)),
    idOf: digest,
    isActiveId: isActiveKey,
    onAnyRevoke(listener) {
      anyRevokeListeners.add(listener);
    },
    revoke(token) {
      drop(digest(token));
    },
    onRevoke(token, listener) {
      const key = digest(token);
      const listeners = revokeListeners.get(key) ?? new Set();
      revokeListeners.set(key, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && revokeListeners.get(key) === listeners) {
          revokeListeners.delete(key);
        }
      };
    },
  };
}
