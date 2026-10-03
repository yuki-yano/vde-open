import { describe, expect, it } from 'vitest';

import { createSessionService } from './session-service.ts';

describe('SEC-001 / SEC-003 session and ticket expiry', () => {
  it('a ticket expires after 60 seconds and can be exchanged only once', () => {
    let now = 1_000_000;
    const sessions = createSessionService(() => now);
    const expired = sessions.createBootstrapTicket();
    now += 60_001;
    expect(sessions.exchange(expired)).toBeNull();

    const ticket = sessions.createBootstrapTicket();
    const token = sessions.exchange(ticket);
    expect(token).not.toBeNull();
    expect(sessions.exchange(ticket)).toBeNull();
    // The ticket itself cannot be used as a session token.
    expect(sessions.authenticate(ticket)).toBe(false);
  });

  it('a session expires 12 hours after its last use and is extended on each use', () => {
    let now = 1_000_000;
    const sessions = createSessionService(() => now);
    const token = sessions.exchange(sessions.createBootstrapTicket()) as string;
    now += 11 * 60 * 60 * 1000;
    expect(sessions.authenticate(token)).toBe(true);
    now += 11 * 60 * 60 * 1000;
    expect(sessions.authenticate(token)).toBe(true);
    now += 12 * 60 * 60 * 1000 + 1;
    expect(sessions.authenticate(token)).toBe(false);
  });

  it('only checking whether it is active does not extend the expiry', () => {
    let now = 1_000_000;
    const sessions = createSessionService(() => now);
    const token = sessions.exchange(sessions.createBootstrapTicket()) as string;
    now += 11 * 60 * 60 * 1000;
    expect(sessions.isActive(token)).toBe(true);
    now += 2 * 60 * 60 * 1000;
    // 13 hours since the last use. The check in between did not extend it.
    expect(sessions.isActive(token)).toBe(false);
    expect(sessions.authenticate(token)).toBe(false);
  });

  it('notifies connections left open of revocation and expiry', () => {
    let now = 1_000_000;
    const sessions = createSessionService(() => now);
    const revoked = sessions.exchange(sessions.createBootstrapTicket()) as string;
    const expired = sessions.exchange(sessions.createBootstrapTicket()) as string;
    const other = sessions.exchange(sessions.createBootstrapTicket()) as string;
    const calls: string[] = [];
    sessions.onRevoke(revoked, () => calls.push('revoked'));
    sessions.onRevoke(expired, () => calls.push('expired'));
    const stop = sessions.onRevoke(other, () => calls.push('other'));

    sessions.revoke(revoked);
    expect(calls).toEqual(['revoked']);
    // Not called when another session is revoked. Not called after unsubscribing either.
    stop();
    sessions.revoke(other);
    expect(calls).toEqual(['revoked']);

    now += 12 * 60 * 60 * 1000 + 1;
    expect(sessions.isActive(expired)).toBe(false);
    expect(calls).toEqual(['revoked', 'expired']);
  });

  it('does not authenticate a revoked session or an unknown token', () => {
    const sessions = createSessionService();
    const token = sessions.exchange(sessions.createBootstrapTicket()) as string;
    sessions.revoke(token);
    expect(sessions.authenticate(token)).toBe(false);
    expect(sessions.authenticate('unknown')).toBe(false);
  });
});
