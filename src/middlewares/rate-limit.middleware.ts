import type { NextFunction, Request, Response } from "express";
import type { RateLimiter } from "../services/rate-limit.service.js";

export function rateLimitBy(limiter: RateLimiter, keyOf: (request: Request) => string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const decision = limiter.consume(keyOf(request));
    if (!decision.allowed) {
      response.setHeader("Retry-After", String(decision.retryAfterSeconds));
      response.status(429).json({ error: "Too many requests. Try again later." });
      return;
    }

    next();
  };
}

export function rateLimitByIp(limiter: RateLimiter) {
  return rateLimitBy(limiter, (request) => request.ip ?? "unknown");
}
