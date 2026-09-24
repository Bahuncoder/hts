import crypto from "node:crypto";
import { canonicalJson, projectLine, type SavedLine, type SignedAudit } from "./auditModel";

/** Proof that an audit result came from our engine, via our proxy.
 *
 *  A saved catalogue is a record customers rely on, so the figures in it must
 *  be ones the engine produced, not ones a browser claimed. The audit proxy
 *  signs what the engine returned with an HMAC; saving verifies it. Anything
 *  edited, unsigned or signed with another secret is refused, and the customer
 *  is asked to run the audit again.
 *
 *  The signed body is {v, at, dataset_revision, assumptions, mpf, lines}: the
 *  lines and dataset revision, plus the entry-level fee and the assumption
 *  text (without which the saved totals and their wording would still be the
 *  browser's) and the time, so a stale audit is not saved as a fresh one.
 *
 *  The secret must be identical on every instance that serves the web app: an
 *  audit signed by one Vercel deployment has to verify on another.
 */

/** Only ever used outside production, so a developer needs no setup. */
const DEV_SECRET = "htsdesk-dev-signing-secret-not-for-production";

/** How long a signed audit stays saveable. Rates and scope can move, so an
 *  audit left open for a day should be run again, not saved as current. */
export const PROOF_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function signingSecret(): string | null {
  const configured = [
    process.env.HTSDESK_SIGNING_SECRET,
    process.env.HTSDESK_EMAIL_SECRET,
    process.env.HTSDESK_ADMIN_TOKEN,
  ].find((s) => s && s.trim());
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? null : DEV_SECRET;
}

function mac(secret: string, body: SignedAudit): string {
  return crypto.createHmac("sha256", secret).update(canonicalJson(body)).digest("base64url");
}

/** Signs an audit. Returns null when no secret is configured in production. */
export function signAudit(body: SignedAudit, secret: string | null = signingSecret()): string | null {
  return secret ? mac(secret, body) : null;
}

export function verifyAudit(
  body: SignedAudit, proof: unknown, secret: string | null = signingSecret(),
): boolean {
  if (!secret || typeof proof !== "string" || !proof) return false;
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(proof);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const FACT_KEYS = [
  "quantity", "quantity_unit", "preference_program", "end_use", "metal_weight_pct", "vehicle_use",
] as const;

export type EngineRequest = { items?: unknown[]; entries?: unknown; by_vessel?: unknown };

/** Builds the signed body from an engine response, or null when it is not one
 *  we can sign (a shape the engine contract does not allow).
 *
 *  `request`, when given, is the same request body the caller sent to the
 *  engine. Two things the engine's own response never echoes back, only
 *  their effect on the numbers, are read from it instead: a line's own
 *  facts (merged in here by position — the engine returns exactly one line
 *  per submitted item, in order, even for one it could not process in
 *  time), and the two shipment-level inputs (`entries`, `by_vessel`) the
 *  entry-level fee and the Harbor Maintenance Fee rest on. Without this a
 *  re-price built from the saved catalogue would have nothing to resubmit
 *  but the code, country and value, and would silently reprice every line
 *  and every fee as if nothing had ever been claimed. */
export function signedBodyFromEngine(
  engine: unknown, request: EngineRequest = {}, at: string = new Date().toISOString(),
): SignedAudit | null {
  if (typeof engine !== "object" || engine === null) return null;
  const e = engine as { lines?: unknown; summary?: unknown };
  if (!Array.isArray(e.lines) || typeof e.summary !== "object" || e.summary === null) return null;
  const s = e.summary as Record<string, unknown>;
  const requestItems = Array.isArray(request.items) ? request.items : [];

  const lines: SavedLine[] = [];
  for (const [i, raw] of e.lines.entries()) {
    const item = requestItems[i];
    const merged = (typeof raw === "object" && raw !== null && !Array.isArray(raw)
        && typeof item === "object" && item !== null && !Array.isArray(item))
      ? { ...Object.fromEntries(FACT_KEYS.map((k) => [k, (item as Record<string, unknown>)[k]])), ...raw }
      : raw;
    const l = projectLine(merged);
    if (!l) return null;
    lines.push(l);
  }
  const assumptions = Array.isArray(s.assumptions) && s.assumptions.every((a) => typeof a === "string")
    ? (s.assumptions as string[]).map((a) => a.slice(0, 2000)) : [];
  const mpf = typeof s.mpf === "number" && Number.isFinite(s.mpf) ? s.mpf : 0;
  const rev = typeof s.dataset_revision === "string" ? s.dataset_revision.slice(0, 200) : "";
  const entries = typeof request.entries === "number" && Number.isInteger(request.entries) && request.entries >= 1
    ? request.entries : 1;
  const by_vessel = request.by_vessel !== false;
  return { v: 1, at, dataset_revision: rev, assumptions, mpf, entries, by_vessel, lines };
}
