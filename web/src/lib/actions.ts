"use server";

import { redirect } from "next/navigation";
import {
  authenticate, currentViewer as _viewer, endSession, hashPassword,
  markEmailVerified, passwordProblem, signUp, startSession,
  validEmail,
} from "./auth";
import crypto from "node:crypto";
import { accountByEmail, accountById, createAccount } from "./store";
import { checkThrottle, clearAttempts } from "./throttle";
import { resetCredential } from "./credentialStore";
import { audit } from "./audit";
import { emailEnabled, send } from "./email";
import { passwordResetEmail, verifyEmail } from "./emails/auth";
import { consume, issue, peek } from "./tokens";
import { safeNext } from "./next";
import { EMPTY_COSTS, parseCosts } from "./landedCost";

export type FormState = { error?: string; notice?: string };

export async function signUpAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");

  if (!validEmail(email)) return { error: "Enter a valid email address." };
  const weak = passwordProblem(password);
  if (weak) return { error: weak };

  const wait = await checkThrottle("signup", email);
  if (wait) return { error: `Too many attempts. Try again in ${wait} minutes.` };

  const existing = await accountByEmail(email);

  // With email available, signup never reveals whether an address is already
  // registered: both branches return the identical "check your inbox" notice
  // and the difference is carried in the mail itself. That closes the
  // enumeration oracle, which cannot be closed while an account is created
  // synchronously.
  if (emailEnabled()) {
    if (existing) {
      const token = await issue("password_reset", { accountId: existing.id, email });
      const mail = passwordResetEmail(token);
      await send({ ...mail, to: email, kind: "signup_existing", accountId: existing.id });
      await audit("password_reset_requested", { accountId: existing.id, email,
        detail: "signup attempted on an existing address" });
    } else {
      const token = await issue("email_verify", {
        email,
        // The password is already hashed here; the account is only created
        // when the link is used, so an unverified address leaves no record.
        payload: JSON.stringify({ hash: hashPassword(password) }),
      });
      const mail = verifyEmail(token);
      await send({ ...mail, to: email, kind: "email_verify" });
    }
    return { notice: "Check your inbox — we have sent you a link to finish signing in." };
  }

  // No provider configured. An account must still be creatable, so the
  // duplicate case is visible; the throttle above is what keeps the resulting
  // oracle from being harvested.
  if (existing) {
    return { error: "An account with that email already exists. Sign in instead." };
  }

  const { id, passwordHash } = await signUp(email, password);
  await audit("signup", { accountId: id, email, detail: "email unverified (no provider)" });
  if (!await startSession(id, passwordHash)) return { error: "Credentials changed. Please sign in again." };
  redirect(safeNext(form.get("next")) ?? "/account");
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!validEmail(email) || password.length > 200) return { error: "That email and password do not match." };

  // Sign-in was unlimited: twenty wrong passwords in a row were accepted
  // without complaint, which is offline-speed guessing against a known email.
  const wait = await checkThrottle("login", email);
  if (wait) {
    await audit("signin_throttled", { email });
    return { error: `Too many sign-in attempts. Try again in ${wait} minutes.` };
  }

  const credential = await authenticate(email, password);
  // One message for both failures: distinguishing them enumerates accounts.
  if (!credential) {
    await audit("signin_failed", { email });
    return { error: "That email and password do not match." };
  }
  const { id, passwordHash } = credential;
  await clearAttempts("login", email);
  await audit("signin", { accountId: id, email });
  if (!await startSession(id, passwordHash)) return { error: "Credentials changed. Please sign in again." };
  // `next` comes from a hidden field, so it is checked again against the
  // allowlist here rather than trusted (lib/next.ts).
  redirect(safeNext(form.get("next")) ?? "/account");
}

export async function logoutAction(): Promise<void> {
  const viewer = await _viewer();
  if (viewer) await audit("signout", { accountId: viewer.account.id, email: viewer.account.email });
  await endSession();
  redirect("/");
}

// --- catalogues -------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { currentViewer } from "./auth";
import {
  CatalogueLimitError, deleteCatalogue, saveCatalogue, unwatchCode, watchCode,
} from "./catalogues";
import { projectLine, type SavedLine, type SignedAudit } from "./auditModel";
import { PROOF_MAX_AGE_MS, signingSecret, verifyAudit } from "./auditProof";
import { markAllRead } from "./diff";
import { repriceCatalogue } from "./reprice";

/** What the browser sends to save an audit. It is not trusted: every figure in
 *  it must be covered by the proof the audit proxy signed (lib/auditProof.ts),
 *  so a catalogue can only ever hold results our engine produced.
 *  `inputs` is the one exception: the amounts the customer typed, kept for
 *  lines that could not be priced and so carry no amount of their own. */
export type SavePayload = {
  name: string;
  lines: unknown[];
  dataset_revision: string;
  assumptions: string[];
  mpf: number;
  entries: number;
  by_vessel: boolean;
  signed_at: string;
  proof: string | null | undefined;
  inputs?: number[];
  landedCosts?: unknown;
};

const RERUN = "These results could not be verified, so they cannot be saved. Run the audit again to save it.";
const MAX_SAVE_LINES = 5000;

export async function saveCatalogueAction(
  payload: SavePayload,
): Promise<{ id?: string; error?: string }> {
  const viewer = await currentViewer();
  if (!viewer) return { error: "Sign in to save a catalogue." };

  const secret = signingSecret();
  if (!secret) {
    console.error("saveCatalogueAction: no signing secret is configured; saving is unavailable");
    return { error: "Saving is unavailable: signing is not configured. Your results are still on screen; you can export them as CSV." };
  }

  const p = payload as Partial<SavePayload> | null;
  if (!p || typeof p !== "object" || !Array.isArray(p.lines)) return { error: RERUN };
  if (!p.lines.length) return { error: "Nothing to save." };
  // The ceiling is on what was submitted, priced or not: an allowance sized
  // for N products does not get 2N by having some of them fail.
  const ceiling = viewer.limits.productsPerAudit;
  if (p.lines.length > ceiling) {
    return { error: `${p.lines.length} products exceeds the ${ceiling.toLocaleString()} allowed in one catalogue.` };
  }
  if (p.lines.length > MAX_SAVE_LINES) return { error: RERUN };

  const lines: SavedLine[] = [];
  for (const raw of p.lines) {
    const l = projectLine(raw);
    if (!l) return { error: RERUN };
    lines.push(l);
  }
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === "string");
  if (typeof p.dataset_revision !== "string" || !strings(p.assumptions)
      || typeof p.mpf !== "number" || !Number.isFinite(p.mpf)
      || typeof p.entries !== "number" || !Number.isInteger(p.entries) || p.entries < 1
      || typeof p.by_vessel !== "boolean"
      || typeof p.signed_at !== "string") {
    return { error: RERUN };
  }

  const body: SignedAudit = {
    v: 1, at: p.signed_at, dataset_revision: p.dataset_revision,
    assumptions: p.assumptions, mpf: p.mpf, entries: p.entries, by_vessel: p.by_vessel, lines,
  };
  if (!verifyAudit(body, p.proof, secret)) {
    console.warn(`saveCatalogueAction: refused for account ${viewer.account.id}: ${
      p.proof ? "proof did not verify" : "no proof"}`);
    return { error: RERUN };
  }
  const age = Date.now() - Date.parse(body.at);
  if (!Number.isFinite(age) || age > PROOF_MAX_AGE_MS || age < -5 * 60_000) {
    return { error: "These results are out of date, so they cannot be saved. Run the audit again to save it." };
  }

  // The amounts the customer submitted: their own input, never a calculation.
  const inputs = Array.isArray(p.inputs) && p.inputs.length === lines.length
    ? p.inputs.map((n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0))
    : [];

  const clean = String(p.name ?? "").trim().slice(0, 120) || "Untitled catalogue";
  let id: string;
  try {
    let costs;
    try { costs = parseCosts(p.landedCosts ?? EMPTY_COSTS); }
    catch (error) { return { error: (error as Error).message }; }
    id = await saveCatalogue(viewer.account.id, clean, body, inputs, costs, viewer.limits.savedCatalogues);
  } catch (err) {
    // Raised inside the save's own transaction, so it holds under concurrency.
    if (err instanceof CatalogueLimitError) return { error: err.message };
    throw err;
  }
  await audit("catalogue_saved", { accountId: viewer.account.id,
    email: viewer.account.email, detail: `${lines.length} products` });
  revalidatePath("/catalogues");
  return { id };
}

export async function deleteCatalogueAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const removed = await deleteCatalogue(viewer.account.id, String(form.get("id") ?? ""));
  if (removed) {
    await audit("catalogue_deleted", { accountId: viewer.account.id,
      email: viewer.account.email });
  }
  revalidatePath("/catalogues");
}

/** Re-runs the engine on a saved catalogue's own lines (their code, or their
 *  description for one that never got one — never their entered value or
 *  stated facts, which are resubmitted unchanged) against current rates, and
 *  updates it in place. Redirects with the outcome in the query string
 *  (matching the pattern already used for a verification notice) rather than
 *  returning a value, since the page that reads it is not the one that
 *  rendered the button — a saved catalogue's own page, not a form's caller. */
export async function repriceCatalogueAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const id = String(form.get("id") ?? "");
  if (!id) return;
  const path = `/catalogues/${encodeURIComponent(id)}`;
  const result = await repriceCatalogue(viewer.account.id, id);
  revalidatePath(path);
  revalidatePath("/catalogues");
  if (!result.ok) {
    redirect(`${path}?repriceError=${encodeURIComponent(result.error)}`);
  }
  await audit("catalogue_repriced", { accountId: viewer.account.id, email: viewer.account.email,
    detail: `${result.changed} of ${result.changed + result.unchanged} lines changed` });
  redirect(`${path}?repriced=1&changed=${result.changed}&unchanged=${result.unchanged}`);
}

export async function watchCodeAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const hts = String(form.get("hts") ?? "").trim();
  if (!/^\d{4}(?:\.\d{2}){0,3}$/.test(hts)) return;
  let watched = true;
  if (String(form.get("watched") ?? "") === "1") {
    await unwatchCode(viewer.account.id, hts);
  } else {
    watched = await watchCode(viewer.account.id, hts);
  }
  revalidatePath(`/hts/${hts}`);
  revalidatePath("/alerts");
  if (!watched) {
    const country = String(form.get("country") ?? "").trim();
    const q = country ? `?country=${encodeURIComponent(country)}&watchError=cap` : "?watchError=cap";
    redirect(`/hts/${hts}${q}`);
  }
}

export async function markAlertsReadAction(): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  await markAllRead(viewer.account.id);
  revalidatePath("/alerts");
}

export async function toggleAlertEmailsAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const { setAlertEmails } = await import("./store");
  const turningOn = String(form.get("on") ?? "") !== "1";
  await setAlertEmails(viewer.account.id, turningOn);
  await audit("alert_emails_changed", { accountId: viewer.account.id,
    email: viewer.account.email, detail: turningOn ? "on" : "off" });
  revalidatePath("/account");
}

// --- password reset & verification ------------------------------------------

/** Always reports the same thing, whether or not the address is registered.
 *  A reset form that says "no such account" is an enumeration oracle. */
export async function requestResetAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim();
  if (!validEmail(email)) return { error: "Enter a valid email address." };

  const wait = await checkThrottle("reset", email);
  if (!wait) {
    const account = await accountByEmail(email);
    if (account) {
      const token = await issue("password_reset", { accountId: account.id, email });
      const mail = passwordResetEmail(token);
      await send({ ...mail, to: email, kind: "password_reset", accountId: account.id });
      await audit("password_reset_requested", { accountId: account.id, email });
    }
  }

  return {
    notice: emailEnabled()
      ? "If that address has an account, we have sent a reset link. It expires in an hour."
      : "Password reset needs email, which is not switched on yet. Contact hello@htsdesk.com.",
  };
}

export async function completeResetAction(_prev: FormState, form: FormData): Promise<FormState> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");

  const weak = passwordProblem(password);
  if (weak) return { error: weak };

  // Checked before hashing, not after: hashPassword is a deliberately
  // expensive, synchronous scrypt call (~60ms on this machine), and this
  // action needs no session — an unauthenticated caller could otherwise
  // spend that cost on every request just by posting a garbage token,
  // burning CPU on the one thread Node runs everything else on. peek() is
  // an indexed lookup, not a security decision on its own (resetCredential
  // still re-checks the same conditions atomically, inside the transaction
  // that actually consumes the token, so a token that expires or gets used
  // in the gap between these two calls is still refused there) — it only
  // lets an obviously-unusable token fail before paying for the hash.
  if (!await peek("password_reset", token)) {
    return { error: "That link has expired or has already been used. Ask for a new one." };
  }

  const passwordHash = hashPassword(password);
  const accountId = await resetCredential(token, passwordHash);
  if (!accountId) {
    return { error: "That link has expired or has already been used. Ask for a new one." };
  }

  const account = await accountById(accountId);
  await audit("password_reset_completed", {
    accountId, email: account?.email,
    detail: "all sessions invalidated",
  });
  if (!await startSession(accountId, passwordHash)) return { error: "Credentials changed again. Please sign in." };
  redirect("/account");
}

/** Creates the account the verification link was issued for. Nothing exists
 *  until this point, so an unverified address leaves no record behind. */
export async function completeVerifyAction(token: string): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const claim = await consume("email_verify", token);
  if (!claim?.email) {
    return { ok: false, reason: "That link has expired or has already been used." };
  }

  const already = await accountByEmail(claim.email);
  if (already) {
    await markEmailVerified(already.id);
    await audit("email_verified", { accountId: already.id, email: claim.email });
    return { ok: true };
  }

  let hash: string | null = null;
  try { hash = (JSON.parse(claim.payload ?? "{}") as { hash?: string }).hash ?? null; }
  catch { hash = null; }
  if (!hash) return { ok: false, reason: "That link is no longer usable. Sign up again." };

  const id = crypto.randomUUID();
  await createAccount(id, claim.email, hash);
  await markEmailVerified(id);
  await audit("signup", { accountId: id, email: claim.email, detail: "email verified" });
  return { ok: true };
}
