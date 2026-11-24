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
      throw new ProviderHttpError(500, "internal");
    });
    const secondary = fakeProvider("deepseek", async (_prompt, { onChunk }) => {
      onChunk("Hola ");
      onChunk("desde DeepSeek");
    });
    const chunks: string[] = [];

    const result = await generateWithFailover("hola", [primary, secondary], {
      ...generationOptions({ onChunk: (chunk) => chunks.push(chunk) }),
    });

    expect(result).toEqual({ provider: "deepseek", content: "Hola desde DeepSeek" });
    expect(chunks).toEqual(["Hola ", "desde DeepSeek"]);
  });

  it("aborts a stalled provider when its timeout expires and fails over", async () => {
    const stalled = fakeProvider(
      "gemini",
      (_prompt, { signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const backup = fakeProvider("grok", async (_prompt, { onChunk }) => onChunk("respuesta"));

    const result = await generateWithFailover("hola", [stalled, backup], generationOptions({ timeoutMs: 20 }));

    expect(result.provider).toBe("grok");
    expect(stalled.stream).toHaveBeenCalledTimes(1);
  });

  it("retries HTTP 503 on the same provider before failing over", async () => {
    let calls = 0;
    const primary = fakeProvider("gemini", async (_prompt, { onChunk }) => {
      calls += 1;
      if (calls === 1) {
        throw new ProviderHttpError(503, "overloaded");
      }
      onChunk("listo");
    });
    const backup = fakeProvider("deepseek", async () => undefined);

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
    const backup = fakeProvider("deepseek", async () => undefined);

    await expect(generateWithFailover("hola", [primary, backup], generationOptions())).rejects.toThrow(
      "connection reset",
    );
    expect(backup.stream).not.toHaveBeenCalled();
  });

  it("treats an empty answer as a failure and tries the next provider", async () => {
    const silent = fakeProvider("gemini", async () => undefined);
    const backup = fakeProvider("grok", async (_prompt, { onChunk }) => onChunk("ok"));

    const result = await generateWithFailover("hola", [silent, backup], generationOptions());

    expect(result.provider).toBe("grok");
  });

  it("throws the last provider error when every provider fails", async () => {
    const first = fakeProvider("gemini", async () => {
      throw new Error("first failed");
    });
    const second = fakeProvider("deepseek", async () => {
      throw new ProviderHttpError(401, "bad key");
    });

    await expect(generateWithFailover("hola", [first, second], generationOptions())).rejects.toThrow("bad key");
  });

  it("fails clearly when no provider is configured", async () => {
    await expect(generateWithFailover("hola", [], generationOptions())).rejects.toThrow(
      "No LLM provider is configured",
    );
  });
});

describe("provider defaults", () => {
  it("tries Gemini first, then DeepSeek, then Grok", () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-key");
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-key");
    vi.stubEnv("XAI_API_KEY", "xai-key");

    expect(getConfiguredLlmProviders().map((provider) => provider.name)).toEqual(["gemini", "deepseek", "grok"]);
    vi.unstubAllEnvs();
  });

  it("sends DeepSeek and Grok requests to their OpenAI-compatible endpoints with default models", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-key");
    vi.stubEnv("XAI_API_KEY", "xai-key");
    vi.stubEnv("DEEPSEEK_MODEL", "");
    vi.stubEnv("GROK_MODEL", "");
    const fetchMock = vi.fn(
      async () => new Response('data: {"choices":[{"delta":{"content":"hola"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    for (const provider of getConfiguredLlmProviders()) {
      await provider.stream("hola", { signal: new AbortController().signal, onChunk: () => undefined });
    }

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const [deepseekCall, grokCall] = calls;
    expect(deepseekCall?.[0]).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(JSON.parse(String(deepseekCall?.[1].body))).toMatchObject({ model: "deepseek-chat", stream: true });
    expect(grokCall?.[0]).toBe("https://api.x.ai/v1/chat/completions");
    expect(JSON.parse(String(grokCall?.[1].body))).toMatchObject({ model: "grok-3-mini", stream: true });

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe("describeProviderError", () => {
  it("redacts configured secrets and keeps the HTTP status", () => {
    const details = describeProviderError(new ProviderHttpError(401, "invalid key sk-secret-123"), ["sk-secret-123"]);

    expect(details.statusCode).toBe(401);
    expect(details.message).toBe("invalid key [REDACTED]");
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
