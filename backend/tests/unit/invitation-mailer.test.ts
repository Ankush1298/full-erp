import { inspect } from 'node:util';
import type { SentMessageInfo, Transporter } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { Secret } from '../../src/config/env.js';
import {
  DisabledInvitationMailer,
  InMemoryInvitationMailer,
  InvitationMail,
  MailerNotConfiguredError,
  SmtpInvitationMailer,
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

  it('invokes onMail callback and exposes getPending() for local dev workflow', async () => {
    const received: string[] = [];
    const mailer = new InMemoryInvitationMailer((record) => {
      received.push(record.to);
    });

    const mail = new InvitationMail(
      'staff@school.test',
      'Staff Member',
      'Anesa Demo School',
      'sample-token-abc',
      new Date(),
    );

    await mailer.send(mail);
    expect(received).toEqual(['staff@school.test']);

    const pending = mailer.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.to).toBe('staff@school.test');
    expect(pending[0]?.token).toBe('sample-token-abc');
    expect(pending[0]?.organizationName).toBe('Anesa Demo School');
  });
});

describe('SmtpInvitationMailer', () => {
  const validConfig = {
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    user: 'notifications@example.test',
    password: new Secret('super-secret-smtp-password'), // secret-scan:allow
    from: 'notifications@example.test',
    webOrigin: 'https://school.example.test',
  };

  it('rejects invalid or CRLF-injected from addresses in constructor', () => {
    expect(
      () =>
        new SmtpInvitationMailer({
          ...validConfig,
          from: 'notifications@example.test\r\nBcc: evil@attacker.test',
        }),
    ).toThrow('Invalid SMTP from address.');

    expect(
      () =>
        new SmtpInvitationMailer({
          ...validConfig,
          from: 'not-an-email',
        }),
    ).toThrow('Invalid SMTP from address.');
  });

  interface TransporterOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    requireTLS?: boolean;
    tls?: { rejectUnauthorized?: boolean; minVersion?: string };
    auth?: { user?: string; pass?: string };
  }

  function createMockTransporter(
    sendMail: (mailOptions: unknown) => Promise<SentMessageInfo>,
  ): Transporter {
    return {
      sendMail,
    } as unknown as Transporter;
  }

  it('rejects recipient email containing CRLF or invalid format', async () => {
    const fakeTransporter = createMockTransporter(vi.fn().mockResolvedValue({} as SentMessageInfo));
    const mailer = new SmtpInvitationMailer(validConfig, fakeTransporter);

    const crlfMail = new InvitationMail(
      'victim@example.test\r\nBcc: evil@attacker.test',
      'Victim',
      'School',
      'token-123',
      new Date(),
    );
    await expect(mailer.send(crlfMail)).rejects.toThrow('Invalid recipient email address.');

    const invalidEmailMail = new InvitationMail(
      'not-a-valid-email',
      'Victim',
      'School',
      'token-123',
      new Date(),
    );
    await expect(mailer.send(invalidEmailMail)).rejects.toThrow('Invalid recipient email address.');
  });

  it('sanitizes recipient name and organization name to prevent header injection', async () => {
    const sendMailSpy = vi.fn().mockResolvedValue({} as SentMessageInfo);
    const fakeTransporter = createMockTransporter(sendMailSpy);
    const mailer = new SmtpInvitationMailer(validConfig, fakeTransporter);

    const mail = new InvitationMail(
      'teacher@school.test',
      'Prof. Smith\r\nSubject: Injected',
      'School\r\nX-Injected: Header',
      'invitation-token-abc',
      new Date(),
    );

    await mailer.send(mail);

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    const callArgs = sendMailSpy.mock.calls[0]![0] as {
      to: string;
      subject: string;
      text: string;
    };
    expect(callArgs.to).toBe('teacher@school.test');
    expect(callArgs.subject).toBe('Invitation to join School X-Injected: Header on Anesa');
    expect(callArgs.text).toContain('Hello Prof. Smith Subject: Injected,');
    expect(callArgs.text).toContain(
      /* secret-scan:allow */ 'https://school.example.test/accept-invite?token=invitation-token-abc&email=teacher%40school.test',
    );
  });

  it('never exposes raw invitation token in error when delivery fails', async () => {
    const fakeTransporter = createMockTransporter(
      vi.fn().mockRejectedValue(new Error('Connection timed out')),
    );
    const mailer = new SmtpInvitationMailer(validConfig, fakeTransporter);

    const secretToken = /* secret-scan:allow */ 'secret-token-do-not-leak';
    const mail = new InvitationMail(
      'teacher@school.test',
      'Prof. Smith',
      'Demo School',
      secretToken,
      new Date(),
    );

    await expect(mailer.send(mail)).rejects.toThrow(
      'Invitation email delivery failed: Connection timed out',
    );
    try {
      await mailer.send(mail);
    } catch (err: unknown) {
      expect((err as Error).message).not.toContain(secretToken);
    }
  });

  it('constructs a default nodemailer transporter with STARTTLS enforced for port 587', () => {
    const mailer = new SmtpInvitationMailer(validConfig);
    const options = (mailer.transporter as unknown as { options: TransporterOptions }).options;
    expect(options.host).toBe('smtp.example.test');
    expect(options.port).toBe(587);
    expect(options.secure).toBe(false);
    expect(options.requireTLS).toBe(true);
    expect(options.tls?.rejectUnauthorized).toBe(true);
    expect(options.tls?.minVersion).toBe('TLSv1.2');
    expect(options.auth?.user).toBe('notifications@example.test');
    expect(options.auth?.pass).toBe('super-secret-smtp-password');
  });

  it('constructs a default nodemailer transporter with explicit TLS for port 465', () => {
    const mailer = new SmtpInvitationMailer({
      ...validConfig,
      port: 465,
      secure: true,
    });
    const options = (mailer.transporter as unknown as { options: TransporterOptions }).options;
    expect(options.port).toBe(465);
    expect(options.secure).toBe(true);
    expect(options.requireTLS).toBe(false);
    expect(options.tls?.rejectUnauthorized).toBe(true);
  });
});
