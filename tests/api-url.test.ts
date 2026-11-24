import { describe, expect, it } from "vitest";
import { normalizeApiBaseUrl } from "../client/src/services/api-url.js";

describe("normalizeApiBaseUrl", () => {
  it("adds /api when the configured URL only contains an origin", () => {
    expect(normalizeApiBaseUrl("https://relay-ai-chat.onrender.com")).toBe(
      "https://relay-ai-chat.onrender.com/api",
    );
  });

  it("preserves an existing /api path and removes trailing slashes", () => {
    expect(normalizeApiBaseUrl("https://relay-ai-chat.onrender.com/api/")).toBe(
      "https://relay-ai-chat.onrender.com/api",
    );
  });

  it("adds /api after a configured path prefix", () => {
    expect(normalizeApiBaseUrl("https://example.com/service/")).toBe(
      "https://example.com/service/api",
    );
  });
});
