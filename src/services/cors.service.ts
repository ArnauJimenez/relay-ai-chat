const defaultCorsOrigin = "http://127.0.0.1:5174";

/**
 * Reads CORS_ORIGIN (comma-separated, or "*") and shares it between Express and Socket.io.
 * CLIENT_ORIGIN is still accepted as a legacy alias.
 */
export function getCorsOrigin(): string | string[] {
  const origins = (process.env.CORS_ORIGIN || process.env.CLIENT_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  if (origins.length === 0) {
    return defaultCorsOrigin;
  }

  return origins.includes("*") ? "*" : origins;
}
