"use server";

import { redirect } from "next/navigation";
import {
  authenticate, currentViewer as _viewer, endSession, hashPassword,
  markEmailVerified, passwordProblem, setPassword, signUp, startSession,
  validEmail,
} from "./auth";
import crypto from "node:crypto";
import { accountByEmail, accountById, createAccount } from "./store";
import { checkThrottle, clearAttempts, recordFailure } from "./throttle";
import { audit } from "./audit";
import { emailEnabled, send } from "./email";
import { passwordResetEmail, verifyEmail } from "./emails/auth";
import { consume, issue } from "./tokens";

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
    await recordFailure("signup", email);
    return { notice: "Check your inbox — we have sent you a link to finish signing in." };
  }

  // No provider configured. An account must still be creatable, so the
  // duplicate case is visible; the throttle above is what keeps the resulting
  // oracle from being harvested.
  if (existing) {
    await recordFailure("signup", email);
    return { error: "An account with that email already exists. Sign in instead." };
  }

  const { id } = await signUp(email, password);
  await audit("signup", { accountId: id, email, detail: "email unverified (no provider)" });
  await startSession(id);
  redirect("/account");
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");

  // Sign-in was unlimited: twenty wrong passwords in a row were accepted
  // without complaint, which is offline-speed guessing against a known email.
  const wait = await checkThrottle("login", email);
  if (wait) {
    await audit("signin_throttled", { email });
    return { error: `Too many sign-in attempts. Try again in ${wait} minutes.` };
  }

  const id = await authenticate(email, password);
  // One message for both failures: distinguishing them enumerates accounts.
  if (!id) {
    await recordFailure("login", email);
    await audit("signin_failed", { email });
    return { error: "That email and password do not match." };
  }
  await clearAttempts("login", email);
  await audit("signin", { accountId: id, email });
  await startSession(id);
  redirect("/account");
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
  deleteCatalogue, saveCatalogue, unwatchCode, watchCode,
  type CatalogueItemInput,
} from "./catalogues";
import { markAllRead } from "./diff";

export async function saveCatalogueAction(
  name: string, items: CatalogueItemInput[],
): Promise<{ id?: string; error?: string }> {
  const viewer = await currentViewer();
  if (!viewer) return { error: "Sign in to save a catalogue." };

  const clean = name.trim().slice(0, 120) || "Untitled catalogue";
  if (!items.length) return { error: "Nothing to save." };
  if (items.length > viewer.plan.skus) {
    return { error: `${items.length} products exceeds the ${viewer.plan.skus.toLocaleString()} allowed on ${viewer.plan.name}.` };
  }

  const id = await saveCatalogue(viewer.account.id, clean, items);
  await audit("catalogue_saved", { accountId: viewer.account.id,
    email: viewer.account.email, detail: `${items.length} products` });
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

export async function watchCodeAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const hts = String(form.get("hts") ?? "");
  if (String(form.get("watched") ?? "") === "1") {
    await unwatchCode(viewer.account.id, hts);
  } else {
    await watchCode(viewer.account.id, hts);
  }
  revalidatePath(`/hts/${hts}`);
  revalidatePath("/alerts");
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
    await recordFailure("reset", email);
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

  const claim = await consume("password_reset", token);
  if (!claim?.accountId) {
    return { error: "That link has expired or has already been used. Ask for a new one." };
  }

  await setPassword(claim.accountId, password);
  const account = await accountById(claim.accountId);
  await audit("password_reset_completed", {
    accountId: claim.accountId, email: account?.email,
    detail: "all sessions invalidated",
  });
  await startSession(claim.accountId);
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
    await startSession(already.id);
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
  await startSession(id);
  return { ok: true };
}
