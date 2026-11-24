import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be set");
}

const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });

// P1001 can't reach server, P1002 server timed out, P1008 operation timed out,
// P1017 server closed the connection, P2024 pool connection timed out.
const unavailableErrorCodes = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);
const networkErrorCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]);

export function isDatabaseUnavailableError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return unavailableErrorCodes.has(error.code);
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    networkErrorCodes.has(error.code)
  );
}
