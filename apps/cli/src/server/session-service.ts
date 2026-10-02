import { createHash, randomBytes } from 'node:crypto';

import { LIMITS } from '@vde-open/shared';

function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export interface SessionService {
  // browserを開くための一回限りのticket。有効期限は60秒。
  createBootstrapTicket(): string;
  // ticketをsession tokenへ交換する。使用済み・期限切れ・未知のticketはnull。
  exchange(ticket: string): string | null;
  authenticate(token: string): boolean;
  // sessionが有効か。利用した時刻は更新しない（接続を保つだけでは期限を延ばさない）。
  isActive(token: string): boolean;
  revoke(token: string): void;
  // sessionが破棄されたときに呼ばれる。開いたままの接続を閉じるために使う。戻り値で解除する。
  onRevoke(token: string, listener: () => void): () => void;
  // sessionを指す、秘密でない識別子。tokenを保持せずに、sessionへ権限を結び付けるために使う。
  idOf(token: string): string;
  // 識別子が指すsessionが有効か。利用した時刻は更新しない。
  isActiveId(sessionId: string): boolean;
  // いずれかのsessionが破棄されたときに、その識別子とともに呼ばれる。
  onAnyRevoke(listener: (sessionId: string) => void): void;
}

// browserの管理sessionを扱う（仕様6.4）。秘密そのものは保持せず、digestで照合する。
// memoryだけに置くので、daemonの再起動ですべて失効する。
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
      // 成否にかかわらず、同じticketは2度使えない。
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
