import { describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../src/services/rate-limit.service.js";
import { getCorsOrigin } from "../src/services/cors.service.js";

describe("createRateLimiter", () => {
  it("blocks requests over the limit until the window resets", () => {
    let now = 0;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, now: () => now });

    expect(limiter.consume("203.0.113.5").allowed).toBe(true);
    expect(limiter.consume("203.0.113.5").allowed).toBe(true);
    expect(limiter.consume("203.0.113.5")).toEqual({ allowed: false, retryAfterSeconds: 60 });

    now = 30_000;
    expect(limiter.consume("203.0.113.5")).toEqual({ allowed: false, retryAfterSeconds: 30 });

    now = 60_000;
    expect(limiter.consume("203.0.113.5").allowed).toBe(true);
  });

  it("tracks each key independently", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 });

    expect(limiter.consume("user-a").allowed).toBe(true);
    expect(limiter.consume("user-a").allowed).toBe(false);
    expect(limiter.consume("user-b").allowed).toBe(true);
  });
});

describe("getCorsOrigin", () => {
  it("falls back to the local client origin when nothing is configured", () => {
    vi.stubEnv("CORS_ORIGIN", "");
    vi.stubEnv("CLIENT_ORIGIN", "");

    expect(getCorsOrigin()).toBe("http://127.0.0.1:5174");
    vi.unstubAllEnvs();
  });

  it("splits a comma-separated list and normalises trailing slashes", () => {
    vi.stubEnv("CORS_ORIGIN", " https://proyecto3.vercel.app/, https://staging.example.com ");

    expect(getCorsOrigin()).toEqual(["https://proyecto3.vercel.app", "https://staging.example.com"]);
    vi.unstubAllEnvs();
  });

  it("accepts the wildcard and the legacy CLIENT_ORIGIN variable", () => {
    vi.stubEnv("CORS_ORIGIN", "*");
    expect(getCorsOrigin()).toBe("*");

    vi.stubEnv("CORS_ORIGIN", "");
    vi.stubEnv("CLIENT_ORIGIN", "https://legacy.example.com");
    expect(getCorsOrigin()).toEqual(["https://legacy.example.com"]);
    vi.unstubAllEnvs();
  });
});
