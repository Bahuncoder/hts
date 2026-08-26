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
