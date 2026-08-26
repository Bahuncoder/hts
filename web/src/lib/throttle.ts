import { headers } from "next/headers";

/** Throttle for credential endpoints.
 *
 *  Sign-in had no limit at all: twenty wrong passwords in a row were accepted
 *  without complaint, which is unlimited offline-speed guessing against a
 *  known email. Counting is per email *and* per client, because either alone
 *  is trivially sidestepped — rotate the email to defeat a per-email limit,
 *  rotate the IP to defeat a per-client one.
 *
 *  In process, so it is correct for a single instance. Several instances need
 *  a shared counter; nginx already fronts this and can carry the coarse limit.
 */
type Bucket = { hits: number[]; };

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

const WINDOW_MS = 15 * 60 * 1000;

// Only FAILURES count. Charging a successful sign-in against the budget means
// an ordinary busy morning consumes it.
const PER_EMAIL = 8;

// Deliberately generous. A whole office shares one address behind NAT, so a
// tight client limit locks out colleagues who did nothing wrong — a denial of
// service against paying customers, dressed up as a security control. The
// per-email limit is what actually stops guessing at one account.
const PER_CLIENT = 60;

function sweep(now: number): void {
  if (now - lastSweep <= WINDOW_MS) return;
  for (const [k, b] of buckets) {
    if (!b.hits.length || now - b.hits[b.hits.length - 1] > WINDOW_MS) buckets.delete(k);
  }
  lastSweep = now;
}

/** Minutes to wait if this key is already over its limit, else null. */
function over(key: string, limit: number): number | null {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket) return null;
  bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);
  buckets.set(key, bucket);
  if (bucket.hits.length < limit) return null;
  return Math.max(1, Math.ceil((WINDOW_MS - (now - bucket.hits[0])) / 60000));
}

function record(key: string): void {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);
  bucket.hits.push(now);
  buckets.set(key, bucket);
}

export async function clientId(): Promise<string> {
  const h = await headers();
  if (process.env.HTSDESK_BEHIND_PROXY === "1") {
    const fwd = h.get("x-forwarded-for");
    if (fwd) return fwd.split(",").pop()!.trim();
  }
  return h.get("x-real-ip") ?? "local";
}

/** Checked BEFORE authenticating. Returns minutes to wait when over. */
export async function checkThrottle(scope: string, email: string): Promise<number | null> {
  const client = await clientId();
  return over(`${scope}:email:${email.toLowerCase()}`, PER_EMAIL)
      ?? over(`${scope}:client:${client}`, PER_CLIENT);
}

/** Called only when an attempt FAILED. A success costs the caller nothing. */
export async function recordFailure(scope: string, email: string): Promise<void> {
  record(`${scope}:email:${email.toLowerCase()}`);
  record(`${scope}:client:${await clientId()}`);
}

/** Clears an email's failures after a genuine sign-in, so someone mistyping
 *  once does not carry a penalty into the rest of the day. */
export function clearAttempts(scope: string, email: string): void {
  buckets.delete(`${scope}:email:${email.toLowerCase()}`);
}
