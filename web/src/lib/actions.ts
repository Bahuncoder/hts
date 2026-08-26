"use server";

import { redirect } from "next/navigation";
import {
  authenticate, endSession, passwordProblem, signUp, startSession, validEmail,
} from "./auth";
import { accountByEmail } from "./store";

export type FormState = { error?: string };

export async function signUpAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");

  if (!validEmail(email)) return { error: "Enter a valid email address." };
  const weak = passwordProblem(password);
  if (weak) return { error: weak };
  if (accountByEmail(email)) {
    return { error: "An account with that email already exists. Sign in instead." };
  }

  const { id } = signUp(email, password);
  await startSession(id);
  redirect("/account");
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const id = authenticate(email, password);
  // One message for both failures: distinguishing them enumerates accounts.
  if (!id) return { error: "That email and password do not match." };
  await startSession(id);
  redirect("/account");
}

export async function logoutAction(): Promise<void> {
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

  const id = saveCatalogue(viewer.account.id, clean, items);
  revalidatePath("/catalogues");
  return { id };
}

export async function deleteCatalogueAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  deleteCatalogue(viewer.account.id, String(form.get("id") ?? ""));
  revalidatePath("/catalogues");
}

export async function watchCodeAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const hts = String(form.get("hts") ?? "");
  if (String(form.get("watched") ?? "") === "1") {
    unwatchCode(viewer.account.id, hts);
  } else {
    watchCode(viewer.account.id, hts);
  }
  revalidatePath(`/hts/${hts}`);
  revalidatePath("/alerts");
}

export async function markAlertsReadAction(): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  markAllRead(viewer.account.id);
  revalidatePath("/alerts");
}

export async function toggleAlertEmailsAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const { setAlertEmails } = await import("./store");
  setAlertEmails(viewer.account.id, String(form.get("on") ?? "") !== "1");
  revalidatePath("/account");
}
