export function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/, "");

  if (!pathname.toLowerCase().endsWith("/api")) {
    url.pathname = `${pathname}/api`;
  }

  return url.toString().replace(/\/$/, "");
}
