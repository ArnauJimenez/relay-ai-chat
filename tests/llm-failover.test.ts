import { describe, expect, it, vi } from "vitest";
import {
  describeProviderError,
  generateWithFailover,
  getConfiguredLlmProviders,
  ProviderHttpError,
  type LlmProvider,
  type LlmProviderName,
} from "../src/services/llm-providers.js";

function fakeProvider(name: LlmProviderName, stream: LlmProvider["stream"]): LlmProvider {
  return { name, stream: vi.fn(stream) };
}

function generationOptions(overrides: { timeoutMs?: number; onChunk?: (chunk: string) => void } = {}) {
  return {
    timeoutMs: overrides.timeoutMs ?? 1_000,
    retryBaseDelayMs: 0,
    onChunk: overrides.onChunk ?? (() => undefined),
  };
}

describe("generateWithFailover", () => {
  it("switches to the next provider when one fails before streaming", async () => {
    const primary = fakeProvider("gemini", async () => {
      throw new ProviderHttpError(500);
    });
    const secondary = fakeProvider("groq", async (_prompt, { onChunk }) => {
      onChunk("Hola ");
      onChunk("desde Groq");
    });
    const chunks: string[] = [];

    const result = await generateWithFailover("hola", [primary, secondary], {
      ...generationOptions({ onChunk: (chunk) => chunks.push(chunk) }),
    });

    expect(result).toEqual({ provider: "groq", content: "Hola desde Groq" });
    expect(chunks).toEqual(["Hola ", "desde Groq"]);
  });

  it("aborts a stalled provider when its timeout expires and fails over", async () => {
    const stalled = fakeProvider(
      "gemini",
      (_prompt, { signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const backup = fakeProvider("cerebras", async (_prompt, { onChunk }) => onChunk("respuesta"));

    const result = await generateWithFailover("hola", [stalled, backup], generationOptions({ timeoutMs: 20 }));

    expect(result.provider).toBe("cerebras");
    expect(stalled.stream).toHaveBeenCalledTimes(1);
  });

  it("retries HTTP 503 on the same provider before failing over", async () => {
    let calls = 0;
    const primary = fakeProvider("gemini", async (_prompt, { onChunk }) => {
      calls += 1;
      if (calls === 1) {
        throw new ProviderHttpError(503);
      }
      onChunk("listo");
    });
    const backup = fakeProvider("mistral", async () => undefined);

    const result = await generateWithFailover("hola", [primary, backup], generationOptions());

    expect(result).toEqual({ provider: "gemini", content: "listo" });
    expect(primary.stream).toHaveBeenCalledTimes(2);
    expect(backup.stream).not.toHaveBeenCalled();
  });

  it("does not switch providers after text already reached the client", async () => {
    const primary = fakeProvider("gemini", async (_prompt, { onChunk }) => {
      onChunk("respuesta parcial");
      throw new Error("connection reset");
    });
    const backup = fakeProvider("groq", async () => undefined);

    await expect(generateWithFailover("hola", [primary, backup], generationOptions())).rejects.toThrow(
      "connection reset",
    );
    expect(backup.stream).not.toHaveBeenCalled();
  });

  it("treats an empty answer as a failure and tries the next provider", async () => {
    const silent = fakeProvider("gemini", async () => undefined);
    const backup = fakeProvider("openrouter", async (_prompt, { onChunk }) => onChunk("ok"));
    const onProviderError = vi.fn();

    const result = await generateWithFailover("hola", [silent, backup], {
      ...generationOptions(),
      onProviderError,
    });

    expect(result.provider).toBe("openrouter");
    expect(onProviderError).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "gemini", reason: "empty_response" }),
    );
  });

  it("throws the last provider error when every provider fails", async () => {
    const first = fakeProvider("gemini", async () => {
      throw new ProviderHttpError(500);
    });
    const second = fakeProvider("mistral", async () => {
      throw new ProviderHttpError(401);
    });

    await expect(generateWithFailover("hola", [first, second], generationOptions())).rejects.toThrow(
      "Provider returned HTTP 401",
    );
  });

  it("fails clearly when no provider is configured", async () => {
    await expect(generateWithFailover("hola", [], generationOptions())).rejects.toThrow(
      "No LLM provider is configured",
    );
  });
});

describe("provider defaults", () => {
  it("configures Gemini and the four new providers in failover order", () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-key");
    vi.stubEnv("GROQ_API_KEY", "groq-key");
    vi.stubEnv("MISTRAL_API_KEY", "mistral-key");
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-key");
    vi.stubEnv("CEREBRAS_API_KEY", "cerebras-key");
    vi.stubEnv("DEEPSEEK_API_KEY", "legacy-key");
    vi.stubEnv("XAI_API_KEY", "legacy-key");

    expect(getConfiguredLlmProviders().map((provider) => provider.name)).toEqual([
      "gemini",
      "groq",
      "mistral",
      "openrouter",
      "cerebras",
    ]);
    vi.unstubAllEnvs();
  });

  it("omits providers whose keys are missing", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "groq-key");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("CEREBRAS_API_KEY", "cerebras-key");
    vi.stubEnv("DEEPSEEK_API_KEY", "legacy-key");
    vi.stubEnv("XAI_API_KEY", "legacy-key");

    expect(getConfiguredLlmProviders().map((provider) => provider.name)).toEqual(["groq", "cerebras"]);
    vi.unstubAllEnvs();
  });

  it("sends provider requests to the documented endpoints with current default models", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "groq-key");
    vi.stubEnv("MISTRAL_API_KEY", "mistral-key");
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-key");
    vi.stubEnv("CEREBRAS_API_KEY", "cerebras-key");
    vi.stubEnv("GROQ_MODEL", "");
    vi.stubEnv("MISTRAL_MODEL", "");
    vi.stubEnv("OPENROUTER_MODEL", "");
    vi.stubEnv("CEREBRAS_MODEL", "");
    const fetchMock = vi.fn(
      async () => new Response('data: {"choices":[{"delta":{"content":"hola"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const providers = getConfiguredLlmProviders();
    for (const provider of providers) {
      await provider.stream("hola", { signal: new AbortController().signal, onChunk: () => undefined });
    }

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      "https://api.groq.com/openai/v1/chat/completions",
      "https://api.mistral.ai/openai/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
      "https://api.cerebras.ai/v1/chat/completions",
    ]);
    expect(calls.map(([, request]) => JSON.parse(String(request.body)).model)).toEqual([
      "openai/gpt-oss-20b",
      "mistral-small-latest",
      "openrouter/free",
      "qwen-3.8-27b",
    ]);

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("parses a final SSE data line without a trailing newline", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "groq-key");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("CEREBRAS_API_KEY", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"final"}}]}', { status: 200 })),
    );
    const chunks: string[] = [];
    const provider = getConfiguredLlmProviders()[0];

    await provider?.stream("hola", {
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toEqual(["final"]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reports HTTP failure metadata without retaining the provider response body", async () => {
    const responseBody = "sensitive echoed request content";
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "groq-key");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("CEREBRAS_API_KEY", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: responseBody } }), { status: 401 })),
    );
    const onProviderError = vi.fn();

    await expect(
      generateWithFailover("private prompt", getConfiguredLlmProviders(), {
        ...generationOptions(),
        onProviderError,
      }),
    ).rejects.toThrow("Provider returned HTTP 401");

    expect(onProviderError).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "groq",
        model: "openai/gpt-oss-20b",
        reason: "http_error",
      }),
    );
    expect(JSON.stringify(onProviderError.mock.calls)).not.toContain(responseBody);
    expect(JSON.stringify(onProviderError.mock.calls)).not.toContain("private prompt");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe("describeProviderError", () => {
  it("redacts configured secrets and keeps the HTTP status", () => {
    const details = describeProviderError(new ProviderHttpError(401), ["sk-secret-123"]);

    expect(details.statusCode).toBe(401);
    expect(details.reason).toBe("http_error");
    expect(details.message).toBe("Provider returned HTTP 401");
  });

  it("reads nested Gemini-style JSON error payloads", () => {
    const error = new Error(
      JSON.stringify({ error: { code: 503, message: JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "Busy" } }) } }),
    );

    expect(describeProviderError(error, [])).toMatchObject({
      statusCode: 503,
      code: "UNAVAILABLE",
      message: "Busy",
    });
  });
});
