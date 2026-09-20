/** Where sign-in and sign-up may send a visitor afterwards.
 *
 *  An exact allowlist, not a prefix or "starts with a slash" test: anything
 *  else (absolute URLs, protocol-relative `//host`, API paths, encoded
 *  tricks) is ignored and the default destination is used. Server actions
 *  re-validate what the form posts, because a hidden field is not trusted.
 */
const EXACT = new Set(["/audit", "/catalogues", "/account", "/alerts"]);
/** /hts/<code>: 4 digits, then up to three 2-digit groups, dots optional. */
const HTS_PATH = /^\/hts\/\d{4}(?:\.?\d{2}){0,3}$/;

export function safeNext(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string") return null;
  return EXACT.has(v) || HTS_PATH.test(v) ? v : null;
}

/** `?next=…` for a link, or "" when there is nothing safe to carry. */
export function nextQuery(next: string | null): string {
  return next ? `?next=${encodeURIComponent(next)}` : "";
}
