import { describe, expect, it } from 'vitest';

import { createSessionService } from './session-service.ts';

describe('SEC-001 / SEC-003 sessionとticketの期限', () => {
  it('ticketは60秒で失効し、1回しか交換できない', () => {
    let now = 1_000_000;
    const sessions = createSessionService(() => now);
    const expired = sessions.createBootstrapTicket();
    now += 60_001;
    expect(sessions.exchange(expired)).toBeNull();

    const ticket = sessions.createBootstrapTicket();
    const token = sessions.exchange(ticket);
    expect(token).not.toBeNull();
    expect(sessions.exchange(ticket)).toBeNull();
    // ticketそのものは、sessionのtokenとして使えない。
    expect(sessions.authenticate(ticket)).toBe(false);
  });

  it('sessionは最後の利用から12時間で失効し、利用のたびに延びる', () => {
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

  it('有効かを確かめるだけでは、期限は延びない', () => {
    let now = 1_000_000;
    const sessions = createSessionService(() => now);
    const token = sessions.exchange(sessions.createBootstrapTicket()) as string;
    now += 11 * 60 * 60 * 1000;
    expect(sessions.isActive(token)).toBe(true);
    now += 2 * 60 * 60 * 1000;
    // 最後の利用から13時間。途中の確認では延びていない。
    expect(sessions.isActive(token)).toBe(false);
    expect(sessions.authenticate(token)).toBe(false);
  });

  it('破棄と期限切れを、開いたままの接続へ知らせる', () => {
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
    // 別のsessionの破棄では呼ばれない。解除した後も呼ばれない。
    stop();
    sessions.revoke(other);
    expect(calls).toEqual(['revoked']);

    now += 12 * 60 * 60 * 1000 + 1;
    expect(sessions.isActive(expired)).toBe(false);
    expect(calls).toEqual(['revoked', 'expired']);
  });

  it('破棄したsessionと未知のtokenは認証しない', () => {
    const sessions = createSessionService();
    const token = sessions.exchange(sessions.createBootstrapTicket()) as string;
    sessions.revoke(token);
    expect(sessions.authenticate(token)).toBe(false);
    expect(sessions.authenticate('unknown')).toBe(false);
  });
});
