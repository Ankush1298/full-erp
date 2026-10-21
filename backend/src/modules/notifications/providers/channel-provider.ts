import type { NotificationChannel } from '../notification.schemas.js';

export interface SendMessageOptions {
  recipientUserId: string;
  destination: string;
  category: string;
  subject?: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessageResult {
  success: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface NotificationChannelProvider {
  readonly channel: NotificationChannel;
  readonly providerName: string;
  send(options: SendMessageOptions): Promise<SendMessageResult>;
}

export interface SentEmailRecord {
  recipientUserId: string;
  destination: string;
  category: string;
  subject?: string;
  bodyLength: number;
  sentAt: Date;
}

/**
 * In-memory email provider for development and testing.
 * Does not expose sensitive body content in public log strings.
 */
export class InMemoryEmailProvider implements NotificationChannelProvider {
  public readonly channel: NotificationChannel = 'EMAIL';
  public readonly providerName = 'in-memory-email';
  public readonly sentMessages: SentEmailRecord[] = [];

  public async send(options: SendMessageOptions): Promise<SendMessageResult> {
    await Promise.resolve();
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const record: SentEmailRecord = {
      recipientUserId: options.recipientUserId,
      destination: options.destination,
      category: options.category,
      bodyLength: options.body.length,
      sentAt: new Date(),
      ...(options.subject !== undefined ? { subject: options.subject } : {}),
    };
    this.sentMessages.push(record);

    return {
      success: true,
      providerMessageId: id,
    };
  }

  public clear(): void {
    this.sentMessages.length = 0;
  }
}

export class DisabledEmailProvider implements NotificationChannelProvider {
  public readonly channel: NotificationChannel = 'EMAIL';
  public readonly providerName = 'disabled-email';

  public async send(): Promise<SendMessageResult> {
    await Promise.resolve();
    return {
      success: false,
      errorCode: 'EMAIL_DISABLED',
      errorMessage: 'Email delivery provider is disabled.',
    };
  }
}
