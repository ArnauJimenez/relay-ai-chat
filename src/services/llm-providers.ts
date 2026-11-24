import { GoogleGenAI } from "@google/genai";

export type LlmProviderName = "gemini" | "deepseek" | "grok";

export interface LlmStreamOptions {
  signal: AbortSignal;
  onChunk: (chunk: string) => void;
}

export interface LlmProvider {
  name: LlmProviderName;
  stream: (prompt: string, options: LlmStreamOptions) => Promise<void>;
}

export interface ProviderErrorDetails {
  name: string;
  message: string;
  statusCode?: number;
  code?: string;
}

export interface GenerateOptions {
  timeoutMs: number;
  retryBaseDelayMs: number;
  onChunk: (chunk: string) => void;
  onProviderError?: (failure: { provider: LlmProviderName; attempt: number; error: unknown }) => void;
}

export interface GenerationResult {
  provider: LlmProviderName;
  content: string;
}

export class ProviderHttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.statusCode = statusCode;
  }
}

const maxAttemptsPerProvider = 3;
const defaultGeminiModel = "gemini-3.8-flash";
const defaultDeepseekModel = "deepseek-chat";
const defaultGrokModel = "grok-3-mini";
const deepseekEndpoint = "https://api.deepseek.com/v1/chat/completions";
const grokEndpoint = "https://api.x.ai/v1/chat/completions";

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
  return [process.env.GEMINI_API_KEY, process.env.DEEPSEEK_API_KEY, process.env.XAI_API_KEY]
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

  message = redactSecrets(message, secrets).trim();
  return {
    name,
    message: message || "Unknown LLM provider error",
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(code === undefined ? {} : { code }),
  };
}

function createGeminiProvider(apiKey: string, model: string): LlmProvider {
  return {
    name: "gemini",
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

// DeepSeek and xAI both expose OpenAI-compatible chat completions with SSE streaming.
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
        const body = await response.text().catch(() => "");
        const detail = body ? `: ${redactSecrets(body.slice(0, 300), [apiKey])}` : "";
        throw new ProviderHttpError(response.status, `${name} returned HTTP ${response.status}${detail}`);
      }

      if (!response.body) {
        throw new Error(`${name} returned an empty response`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");

          if (!line.startsWith("data:")) {
            continue;
          }

          const data = line.slice("data:".length).trim();
          if (data === "[DONE]") {
            await reader.cancel();
            return;
          }

          const chunk = (JSON.parse(data) as ChatCompletionChunk).choices?.[0]?.delta?.content;
          if (chunk) {
            onChunk(chunk);
          }
        }
      }
    },
  };
}

/** Providers in failover order: Gemini, then DeepSeek, then Grok. Only configured ones are returned. */
export function getConfiguredLlmProviders(): LlmProvider[] {
  const providers: LlmProvider[] = [];

  const geminiKey = readSecret(process.env.GEMINI_API_KEY);
  if (geminiKey) {
    providers.push(createGeminiProvider(geminiKey, process.env.GEMINI_MODEL || defaultGeminiModel));
  }

  const deepseekKey = readSecret(process.env.DEEPSEEK_API_KEY);
  if (deepseekKey) {
    providers.push(
      createChatCompletionsProvider({
        name: "deepseek",
        endpoint: deepseekEndpoint,
        apiKey: deepseekKey,
        model: process.env.DEEPSEEK_MODEL || defaultDeepseekModel,
      }),
    );
  }

  const grokKey = readSecret(process.env.XAI_API_KEY);
  if (grokKey) {
    providers.push(
      createChatCompletionsProvider({
        name: "grok",
        endpoint: grokEndpoint,
        apiKey: grokKey,
        model: process.env.GROK_MODEL || defaultGrokModel,
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
        () => controller.abort(new Error(`${provider.name} timed out after ${options.timeoutMs} ms`)),
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

        if (content) {
          return { provider: provider.name, content };
        }
        failure = new Error(`${provider.name} returned an empty response`);
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timer);
      }

      lastError = failure;
      options.onProviderError?.({ provider: provider.name, attempt: attempt + 1, error: failure });

      if (content) {
        throw failure;
      }

      const isLastAttempt = attempt === maxAttemptsPerProvider - 1;
      if (describeProviderError(failure, []).statusCode !== 503 || isLastAttempt) {
        break;
      }

      await sleep(options.retryBaseDelayMs * 2 ** attempt);
    }
  }

  throw lastError;
}
