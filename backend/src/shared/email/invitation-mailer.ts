import { inspect } from 'node:util';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { SmtpConfig } from '../../config/env.js';

export type { SmtpConfig };

/**
 * The ONE place the raw invitation token exists outside the recipient's mailbox. A provider turns this into a message (the
 * accept link is the provider's concern: it needs the web origin, which this module deliberately does not know).
 *
 * The token is held in a private field; `toJSON` and `inspect` omit it, so a logger, an error serializer or a test snapshot
 * that stringifies the object cannot leak it. Read it ONLY inside a provider's `send`.
 */
export class InvitationMail {
  readonly #token: string;
  constructor(
    readonly to: string,
    readonly recipientName: string,
    readonly organizationName: string,
    token: string,
    readonly expiresAt: Date,
  ) {
    this.#token = token;
  }
  /** For a provider building the message. Never log, persist or return it. */
  revealToken(): string {
    return this.#token;
  }
  toJSON(): Record<string, unknown> {
    return {
      to: this.to,
      organizationName: this.organizationName,
      expiresAt: this.expiresAt,
      token: '[redacted]',
    };
  }
  [inspect.custom](): string {
    return 'InvitationMail { token: [redacted] }';
  }
}

/** Raised by a mailer that is not configured to send; the caller treats it as a delivery failure, never as a crash. */
export class MailerNotConfiguredError extends Error {
  constructor() {
    super('No e-mail provider is configured.');
    this.name = 'MailerNotConfiguredError';
  }
}

export interface InvitationMailer {
  /** Resolves when the provider accepted the message. Rejects on any failure. Called AFTER the invitation committed. */
  send(mail: InvitationMail): Promise<void>;
}

/**
 * The default: sends nothing and fails closed.
 */
export class DisabledInvitationMailer implements InvitationMailer {
  send(): Promise<void> {
    return Promise.reject(new MailerNotConfiguredError());
  }
}

export interface DevInvitationRecord {
  to: string;
  recipientName: string;
  organizationName: string;
  token: string;
  expiresAt: Date;
}

/**
 * Local development and tests ONLY: keeps the messages in memory so a test (or a developer's script) can read the token.
 * It writes nothing to disk and nothing to a log. Never wire it in a production build.
 */
export class InMemoryInvitationMailer implements InvitationMailer {
  readonly sent: InvitationMail[] = [];
  constructor(private readonly onMail?: ((record: DevInvitationRecord) => void) | undefined) {}

  send(mail: InvitationMail): Promise<void> {
    this.sent.push(mail);
    this.onMail?.({
      to: mail.to,
      recipientName: mail.recipientName,
      organizationName: mail.organizationName,
      token: mail.revealToken(),
      expiresAt: mail.expiresAt,
    });
    return Promise.resolve();
  }

  getPending(): DevInvitationRecord[] {
    return this.sent.map((m) => ({
      to: m.to,
      recipientName: m.recipientName,
      organizationName: m.organizationName,
      token: m.revealToken(),
      expiresAt: m.expiresAt,
    }));
  }
}

const CRLF_RE = /[\r\n]/;
const CRLF_GLOBAL_RE = /[\r\n]+/g;
const EMAIL_RE = /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/;

/**
 * Maintained, security-reviewed SMTP delivery using nodemailer.
 * - Enforces STARTTLS on port 587 (requireTLS: true).
 * - Enforces implicit TLS on port 465 (secure: true).
 * - Enforces TLS certificate & hostname validation (rejectUnauthorized: true, TLSv1.2+).
 * - Sanitizes recipient, sender, and headers to prevent CRLF injection.
 * - Never logs or leaks raw tokens or credentials.
 */
export class SmtpInvitationMailer implements InvitationMailer {
  readonly transporter: Transporter;

  constructor(
    private readonly config: SmtpConfig,
    transporterOverride?: Transporter,
  ) {
    if (CRLF_RE.test(config.from) || !EMAIL_RE.test(config.from)) {
      throw new Error('Invalid SMTP from address.');
    }

    const pass = config.password ? config.password.reveal() : undefined;

    const isExplicitTls = config.port === 465 || config.secure === true;

    this.transporter =
      transporterOverride ??
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: isExplicitTls,
        requireTLS: !isExplicitTls, // strictly enforce STARTTLS for submission port 587
        auth:
          config.user && pass
            ? {
                user: config.user,
                pass,
              }
            : undefined,
        tls: {
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
        },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
  }

  async send(mail: InvitationMail): Promise<void> {
    if (CRLF_RE.test(mail.to) || !EMAIL_RE.test(mail.to)) {
      throw new Error('Invalid recipient email address.');
    }

    // Strip CRLF from subject/content to prevent header injection
    const cleanOrg = mail.organizationName.replace(CRLF_GLOBAL_RE, ' ').trim();
    const cleanName = mail.recipientName.replace(CRLF_GLOBAL_RE, ' ').trim();

    const origin = (this.config.webOrigin ?? 'http://localhost:5173').replace(/\/+$/, '');
    const params = new URLSearchParams({ token: mail.revealToken(), email: mail.to });
    const acceptUrl = `${origin}/accept-invite?${params.toString()}`;

    try {
      await this.transporter.sendMail({
        from: this.config.from,
        to: mail.to,
        subject: `Invitation to join ${cleanOrg} on Anesa`,
        text: [
          `Hello ${cleanName},`,
          '',
          `You have been invited to join ${cleanOrg} on Anesa Campus OS.`,
          '',
          `To accept your invitation and activate your account, please open the following link:`,
          acceptUrl,
          '',
          `This invitation link is valid for 7 days and can only be used once.`,
          '',
          `If you were not expecting this invitation, you can safely ignore this email.`,
          '',
          `— Anesa Campus OS`,
        ].join('\r\n'),
      });
    } catch (err) {
      // Never expose the token in the error message
      const msg = err instanceof Error ? err.message : 'SMTP send failed';
      throw new Error(`Invitation email delivery failed: ${msg}`, { cause: err });
    }
  }
}
