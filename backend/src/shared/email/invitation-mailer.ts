import { inspect } from 'node:util';

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
 * The default: sends nothing and fails closed. No provider and no secret is introduced by this phase. With this mailer an
 * invitation is created but its token reaches nobody (delivery FAILED), so an administrator must re-invite once a real
 * provider is wired in. Production needs a reviewed provider (a separate approval); until then invitations are not usable.
 */
export class DisabledInvitationMailer implements InvitationMailer {
  send(): Promise<void> {
    return Promise.reject(new MailerNotConfiguredError());
  }
}

/**
 * Local development and tests ONLY: keeps the messages in memory so a test (or a developer's script) can read the token.
 * It writes nothing to disk and nothing to a log. Never wire it in a production build.
 */
export class InMemoryInvitationMailer implements InvitationMailer {
  readonly sent: InvitationMail[] = [];
  send(mail: InvitationMail): Promise<void> {
    this.sent.push(mail);
    return Promise.resolve();
  }
}
