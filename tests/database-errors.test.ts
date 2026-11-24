import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/proyecto3_test";
const { isDatabaseUnavailableError } = await import("../src/services/prisma.service.js");

describe("isDatabaseUnavailableError", () => {
  it("recognises connectivity failures so the API can answer 503", () => {
    const unreachable = new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
      code: "P1001",
      clientVersion: "7.10.1",
    });
    const initialization = new Prisma.PrismaClientInitializationError("Can't reach database server", "7.10.1");
    const networkError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

    expect(isDatabaseUnavailableError(unreachable)).toBe(true);
    expect(isDatabaseUnavailableError(initialization)).toBe(true);
    expect(isDatabaseUnavailableError(networkError)).toBe(true);
  });

  it("does not treat application errors as outages", () => {
    const uniqueViolation = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "7.10.1",
    });

    expect(isDatabaseUnavailableError(uniqueViolation)).toBe(false);
    expect(isDatabaseUnavailableError(new Error("boom"))).toBe(false);
  });
});
