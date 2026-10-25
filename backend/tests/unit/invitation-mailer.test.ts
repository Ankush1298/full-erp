import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  DisabledInvitationMailer,
  InMemoryInvitationMailer,
  InvitationMail,
  MailerNotConfiguredError,
} from '../../src/shared/email/invitation-mailer.js';

describe('InvitationMail', () => {
  const expiresAt = new Date('2026-11-01T00:00:00.000Z');
  const token = /* secret-scan:allow */ 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

  it('exposes public metadata but keeps raw token protected', () => {
    const mail = new InvitationMail(
      'student@college.test',
      'Test Student',
      'Test University',
      token,
      expiresAt,
    );

    expect(mail.to).toBe('student@college.test');
    expect(mail.recipientName).toBe('Test Student');
    expect(mail.organizationName).toBe('Test University');
    expect(mail.expiresAt).toBe(expiresAt);

    // Raw token is strictly accessed via revealToken()
    expect(mail.revealToken()).toBe(token);
  });

  it('redacts raw token in toJSON serialization', () => {
    const mail = new InvitationMail(
      'student@college.test',
      'Test Student',
      'Test University',
      token,
      expiresAt,
    );

    const serialized = JSON.stringify(mail);
    expect(serialized).not.toContain(token);
    expect(JSON.parse(serialized)).toEqual({
      to: 'student@college.test',
      organizationName: 'Test University',
      expiresAt: expiresAt.toISOString(),
      token: '[redacted]',
    });
  });

  it('redacts raw token in node inspect serialization', () => {
    const mail = new InvitationMail(
      'student@college.test',
      'Test Student',
      'Test University',
      token,
      expiresAt,
    );

    const inspected = inspect(mail);
    expect(inspected).not.toContain(token);
    expect(inspected).toBe('InvitationMail { token: [redacted] }');
  });
});

describe('DisabledInvitationMailer', () => {
  it('fails closed and rejects with MailerNotConfiguredError', async () => {
    const mailer = new DisabledInvitationMailer();
    await expect(mailer.send()).rejects.toThrow(MailerNotConfiguredError);
    await expect(mailer.send()).rejects.toThrow('No e-mail provider is configured.');
  });
});

describe('InMemoryInvitationMailer', () => {
  it('records sent messages in memory for test verification', async () => {
    const mailer = new InMemoryInvitationMailer();
    const mail = new InvitationMail(
      'student@college.test',
      'Test Student',
      'Test University',
      'raw-token-123',
      new Date(),
    );

    expect(mailer.sent).toHaveLength(0);
    await mailer.send(mail);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('student@college.test');
    expect(mailer.sent[0]!.revealToken()).toBe('raw-token-123');
  });
});
