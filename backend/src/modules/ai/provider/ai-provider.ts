import { AppError } from '../../../shared/errors/http-errors.js';
import type { AiFinishReason, AiMessage, AiToolCall, AiUsage } from '../ai.schemas.js';

export interface AiToolParameterDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiProviderChatRequest {
  messages: readonly AiMessage[];
  tools?: readonly AiToolParameterDef[] | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
}

export interface AiProviderChatResponse {
  message: AiMessage;
  finishReason: AiFinishReason;
  usage: AiUsage;
  toolCalls?: readonly AiToolCall[] | undefined;
}

export interface AiProviderAdapter {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  chat(
    request: AiProviderChatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<AiProviderChatResponse>;
}

/**
 * Default safe provider when no external or development provider is configured.
 * Fails closed with 503 SERVICE_UNAVAILABLE without attempting any outbound network calls.
 */
export class DisabledAiProvider implements AiProviderAdapter {
  readonly name = 'disabled';

  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  chat(): Promise<AiProviderChatResponse> {
    return Promise.reject(
      new AppError(503, 'AI_PROVIDER_UNAVAILABLE', 'AI provider is disabled or unavailable.'),
    );
  }
}

export interface DeterministicHandlerOptions {
  cannedResponses?: readonly AiProviderChatResponse[];
  handler?: (
    req: AiProviderChatRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<AiProviderChatResponse> | AiProviderChatResponse;
  delayMs?: number;
  available?: boolean;
}

/**
 * Deterministic, safe in-memory provider for testing and development.
 * Provides predictable completions, supports simulated tool-calls, timeouts, and quota errors.
 */
export class DeterministicAiProvider implements AiProviderAdapter {
  readonly name = 'deterministic';
  private cannedIndex = 0;
  private readonly cannedResponses: readonly AiProviderChatResponse[];
  private readonly customHandler?:
    | ((
        req: AiProviderChatRequest,
        options?: { signal?: AbortSignal },
      ) => Promise<AiProviderChatResponse> | AiProviderChatResponse)
    | undefined;
  private readonly delayMs: number;
  private isAvailableState: boolean;

  constructor(options: DeterministicHandlerOptions = {}) {
    this.cannedResponses = options.cannedResponses ?? [];
    this.customHandler = options.handler;
    this.delayMs = options.delayMs ?? 0;
    this.isAvailableState = options.available ?? true;
  }

  setAvailable(available: boolean): void {
    this.isAvailableState = available;
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.isAvailableState);
  }

  async chat(
    request: AiProviderChatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<AiProviderChatResponse> {
    if (!this.isAvailableState) {
      throw new AppError(503, 'AI_PROVIDER_UNAVAILABLE', 'AI provider is disabled or unavailable.');
    }

    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        if (options?.signal) {
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new AppError(504, 'AI_PROVIDER_TIMEOUT', 'AI provider request timed out.'));
            },
            { once: true },
          );
        }
      });
    }

    if (options?.signal?.aborted) {
      throw new AppError(504, 'AI_PROVIDER_TIMEOUT', 'AI provider request timed out.');
    }

    if (this.customHandler) {
      return this.customHandler(request, options);
    }

    if (this.cannedResponses.length > 0) {
      const response = this.cannedResponses[this.cannedIndex % this.cannedResponses.length]!;
      this.cannedIndex += 1;
      return response;
    }

    // Default fallback: deterministic echo/acknowledgement
    const lastMessage = request.messages[request.messages.length - 1];
    const userText = lastMessage?.content ?? '';
    const responseContent = `Deterministic completion for: ${userText.slice(0, 100)}`;

    return {
      message: {
        role: 'assistant',
        content: responseContent,
      },
      finishReason: 'stop',
      usage: {
        promptTokens: Math.ceil(userText.length / 4),
        completionTokens: Math.ceil(responseContent.length / 4),
        totalTokens: Math.ceil((userText.length + responseContent.length) / 4),
      },
    };
  }
}
