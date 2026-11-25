import { GoogleGenAI } from "@google/genai";

export type LlmProviderName = "gemini" | "groq" | "mistral" | "openrouter" | "cerebras";

export interface LlmStreamOptions {
  signal: AbortSignal;
  onChunk: (chunk: string) => void;
}

export interface LlmProvider {
  name: LlmProviderName;
  model?: string;
  stream: (prompt: string, options: LlmStreamOptions) => Promise<void>;
}

export type ProviderFailureReason =
  | "http_error"
  | "empty_response"
  | "timeout"
  | "network_error"
  | "invalid_stream"
  | "provider_error";

export interface ProviderErrorDetails {
  name: string;
  message: string;
  reason: ProviderFailureReason;
  statusCode?: number;
  code?: string;
}

export interface GenerateOptions {
  timeoutMs: number;
  retryBaseDelayMs: number;
  onChunk: (chunk: string) => void;
  onProviderError?: (failure: {
    provider: LlmProviderName;
    model?: string;
    attempt: number;
    reason: ProviderFailureReason;
    error: unknown;
  }) => void;
}

export interface GenerationResult {
  provider: LlmProviderName;
  content: string;
}

export class ProviderHttpError extends Error {
  statusCode: number;

  constructor(statusCode: number) {
    super(`Provider returned HTTP ${statusCode}`);
    this.name = "ProviderHttpError";
    this.statusCode = statusCode;
  }
}

class EmptyProviderResponseError extends Error {
  constructor(provider: LlmProviderName) {
    super(`${provider} returned an empty response`);
    this.name = "EmptyProviderResponseError";
  }
}

class InvalidProviderStreamError extends Error {
  constructor() {
    super("Provider returned an invalid stream");
    this.name = "InvalidProviderStreamError";
  }
}

class ProviderTimeoutError extends Error {
  constructor() {
    super("Provider request timed out");
    this.name = "ProviderTimeoutError";
  }
}

const maxAttemptsPerProvider = 3;
const defaultGeminiModel = "gemini-3.8-flash";
const defaultGroqModel = "openai/gpt-oss-20b";
const defaultMistralModel = "mistral-small-latest";
const defaultOpenRouterModel = "openrouter/free";
const defaultCerebrasModel = "qwen-3.8-27b";
const groqEndpoint = "https://api.groq.com/openai/v1/chat/completions";
const mistralEndpoint = "https://api.mistral.ai/openai/v1/chat/completions";
const openRouterEndpoint = "https://openrouter.ai/api/v1/chat/completions";
const cerebrasEndpoint = "https://api.cerebras.ai/v1/chat/completions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readSecret(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();
}

export function getLlmSecrets(): string[] {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GROQ_API_KEY,
    process.env.MISTRAL_API_KEY,
    process.env.OPENROUTER_API_KEY,
    process.env.CEREBRAS_API_KEY,
  ]
    .map(readSecret)
    .filter(Boolean);
}

export function redactSecrets(text: string, secrets: string[]): string {
  return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), text);
}

export function describeProviderError(error: unknown, secrets: string[]): ProviderErrorDetails {
  const name = error instanceof Error ? error.name : "Error";
  let message = error instanceof Error ? error.message : String(error);
  let statusCode =
    error instanceof ProviderHttpError
      ? error.statusCode
      : isRecord(error) && typeof error.status === "number"
        ? error.status
        : undefined;
  let code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;

  try {
    const response = JSON.parse(message) as unknown;
    if (isRecord(response) && isRecord(response.error)) {
      if (typeof response.error.code === "number") {
        statusCode = response.error.code;
      }

      if (typeof response.error.message === "string") {
        message = response.error.message;
        try {
          const nestedResponse = JSON.parse(message) as unknown;
          if (isRecord(nestedResponse) && isRecord(nestedResponse.error)) {
            if (typeof nestedResponse.error.code === "number") {
              statusCode = nestedResponse.error.code;
            }
            if (typeof nestedResponse.error.status === "string") {
              code = nestedResponse.error.status;
            }
            if (typeof nestedResponse.error.message === "string") {
              message = nestedResponse.error.message;
            }
          }
        } catch {
          // Keep the readable API message when the nested value is not JSON.
        }
      }
    }
  } catch {
    // Keep the original SDK error message when it is not JSON.
  }

  const reason: ProviderFailureReason =
    error instanceof ProviderTimeoutError
      ? "timeout"
      : error instanceof ProviderHttpError || statusCode !== undefined
        ? "http_error"
        : error instanceof EmptyProviderResponseError
          ? "empty_response"
          : error instanceof InvalidProviderStreamError
            ? "invalid_stream"
            : isRecord(error) &&
                typeof error.code === "string" &&
                /^(ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR)/.test(error.code)
              ? "network_error"
              : "provider_error";

  message = redactSecrets(message, secrets).trim();
  return {
    name,
    message: message || "Unknown LLM provider error",
    reason,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(code === undefined ? {} : { code }),
  };
}

function createGeminiProvider(apiKey: string, model: string): LlmProvider {
  return {
    name: "gemini",
    model,
    async stream(prompt, { signal, onChunk }) {
      const ai = new GoogleGenAI({ apiKey });
      const stream = await ai.models.generateContentStream({
        model,
        contents: prompt,
        config: { abortSignal: signal },
      });

      for await (const response of stream) {
        if (response.text) {
          onChunk(response.text);
        }
      }
    },
  };
}

interface ChatCompletionChunk {
  choices?: { delta?: { content?: string | null } }[];
}

// These providers expose OpenAI-compatible chat completions with SSE streaming.
function createChatCompletionsProvider({
  name,
  endpoint,
  apiKey,
  model,
}: {
  name: Exclude<LlmProviderName, "gemini">;
  endpoint: string;
  apiKey: string;
  model: string;
}): LlmProvider {
  return {
    name,
    model,
    async stream(prompt, { signal, onChunk }) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderHttpError(response.status);
      }

      if (!response.body) {
        throw new EmptyProviderResponseError(name);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const processLine = (line: string): boolean => {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith("data:")) {
          return false;
        }

        const data = trimmedLine.slice("data:".length).trim();
        if (data === "[DONE]") {
          return true;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(data) as unknown;
        } catch {
          throw new InvalidProviderStreamError();
        }

        if (isRecord(payload) && payload.error) {
          throw new InvalidProviderStreamError();
        }

        const chunk = (payload as ChatCompletionChunk).choices?.[0]?.delta?.content;
        if (chunk) {
          onChunk(chunk);
        }
        return false;
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            processLine(buffer);
          }
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");

          if (processLine(line)) {
            await reader.cancel();
            return;
          }
        }
      }
    },
  };
}

/** Providers are tried in order; providers without configured keys are omitted. */
export function getConfiguredLlmProviders(): LlmProvider[] {
  const providers: LlmProvider[] = [];

  const geminiKey = readSecret(process.env.GEMINI_API_KEY);
  if (geminiKey) {
    providers.push(createGeminiProvider(geminiKey, readSecret(process.env.GEMINI_MODEL) || defaultGeminiModel));
  }

  const configuredChatProviders: {
    name: Exclude<LlmProviderName, "gemini">;
    key: string | undefined;
    endpoint: string;
    model: string;
    modelOverride: string | undefined;
  }[] = [
    {
      name: "groq",
      key: readSecret(process.env.GROQ_API_KEY),
      endpoint: groqEndpoint,
      model: defaultGroqModel,
      modelOverride: process.env.GROQ_MODEL,
    },
    {
      name: "mistral",
      key: readSecret(process.env.MISTRAL_API_KEY),
      endpoint: mistralEndpoint,
      model: defaultMistralModel,
      modelOverride: process.env.MISTRAL_MODEL,
    },
    {
      name: "openrouter",
      key: readSecret(process.env.OPENROUTER_API_KEY),
      endpoint: openRouterEndpoint,
      model: defaultOpenRouterModel,
      modelOverride: process.env.OPENROUTER_MODEL,
    },
    {
      name: "cerebras",
      key: readSecret(process.env.CEREBRAS_API_KEY),
      endpoint: cerebrasEndpoint,
      model: defaultCerebrasModel,
      modelOverride: process.env.CEREBRAS_MODEL,
    },
  ];

  for (const provider of configuredChatProviders) {
    if (!provider.key) {
      continue;
    }

    providers.push(
      createChatCompletionsProvider({
        name: provider.name,
        endpoint: provider.endpoint,
        apiKey: provider.key,
        model: readSecret(provider.modelOverride) || provider.model,
      }),
    );
  }

  return providers;
}

/**
 * Tries each provider in order. Every attempt has its own AbortController timeout.
 * A failure switches to the next provider, except after text has already reached the
 * client (switching then would mix two answers). HTTP 503 is retried on the same provider
 * with exponential backoff before failing over.
 */
export async function generateWithFailover(
  prompt: string,
  providers: LlmProvider[],
  options: GenerateOptions,
): Promise<GenerationResult> {
  if (providers.length === 0) {
    throw new Error("No LLM provider is configured");
  }

  let content = "";
  let lastError: unknown = new Error("No LLM provider produced a response");

  for (const provider of providers) {
    for (let attempt = 0; attempt < maxAttemptsPerProvider; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new ProviderTimeoutError()),
        options.timeoutMs,
      );

      let failure: unknown;
      try {
        await provider.stream(prompt, {
          signal: controller.signal,
          onChunk: (chunk) => {
            content += chunk;
            options.onChunk(chunk);
          },
        });

        if (controller.signal.aborted) {
          failure = new ProviderTimeoutError();
        }

        if (failure) {
          throw failure;
        }

        if (content) {
          return { provider: provider.name, content };
        }
        failure = new EmptyProviderResponseError(provider.name);
      } catch (error) {
        failure = controller.signal.aborted ? new ProviderTimeoutError() : error;
      } finally {
        clearTimeout(timer);
      }

      lastError = failure;
      const details = describeProviderError(failure, []);
      options.onProviderError?.({
        provider: provider.name,
        ...(provider.model === undefined ? {} : { model: provider.model }),
        attempt: attempt + 1,
        reason: details.reason,
        error: failure,
      });

      if (content) {
        throw failure;
      }

      const isLastAttempt = attempt === maxAttemptsPerProvider - 1;
      if (details.statusCode !== 503 || isLastAttempt) {
        break;
      }

      await sleep(options.retryBaseDelayMs * 2 ** attempt);
    }
  }

  throw lastError;
}
