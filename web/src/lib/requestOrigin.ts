/** Route handlers need an explicit CSRF boundary. Next may rewrite request.url
 * to its internal listener, so compare the browser Origin with the public Host
 * unless a canonical SITE_URL is configured. */
export function sameOrigin(request: Request): boolean {
  try {
    const origin = request.headers.get("origin");
    if (!origin) return false;
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return process.env.SITE_URL
      ? parsed.origin === new URL(process.env.SITE_URL).origin
      : parsed.host === request.headers.get("host");
  } catch { return false; }
}
