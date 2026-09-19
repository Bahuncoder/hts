/** Server-side client for the HTSDesk API. */

export const API_BASE =
  process.env.HTSDESK_API ?? "http://127.0.0.1:8099";

/** Server-side calls carry the engine key.
 *
 *  These run during render, so one visitor's page can fan out into several
 *  engine calls and a busy page would otherwise trip the anonymous limit for
 *  everyone. The key is read here and never reaches the browser.
 */
export function engineHeaders(): Record<string, string> {
  const key = process.env.HTSDESK_API_KEY;
  return key ? { "x-api-key": key } : {};
}

export type DutyComponent = {
  label: string;
  rate_pct: number | null;
  amount: number;
  basis: string;
  authority: string;
};

export type Quote = {
  hts: string;
  country: string;
  entered_value: number;
  components: DutyComponent[];
  total_duty: number;
  effective_rate_pct: number;
  landed_cost: number;
  refundable: DutyComponent[];
  refundable_amount: number;
  warnings: string[];
  /** Chapter 99 headings that cover this origin but whose product scope is
   *  only in the U.S. Notes; excluded from the total. */
  scope_unverified: string[];
  /** Reasons the total omits something it should include. */
  incomplete?: string[];
  /** False when `incomplete` or `scope_unverified` is non-empty. */
  complete?: boolean;
  country_code?: string;
  dataset_revision?: string;
};

export type Ruling = {
  ruling_number: string;
  subject: string;
  ruling_date: string;
  revoked: boolean | number;
  url: string;
};

export type Candidate = {
  hts: string;
  description: string;
  full_path: string;
  general_rate: string;
  score: number;
  ruling_support: number;
  rulings: { ruling: string; subject: string; date: string; revoked: boolean; url: string }[];
  reasoning: string;
  confidence: "high" | "medium" | "low";
};

export type HtsDetail = {
  hts: string;
  description: string;
  full_path: string;
  chapter: string;
  is_leaf: boolean;
  rates: { general: string; special: string; other: string };
  units: string[];
  quote: Quote | null;
  rulings: Ruling[];
  trade_remedies: {
    heading: string;
    countries: string;
    note: string;
    effective_from: string | null;
    rate_pct: number | null;
    raw_rate: string;
    suspended: number;
  }[];
};

/** Why an engine call did not produce data.
 *
 *  Callers must be able to tell "this code does not exist" from "we could not
 *  ask", so a failure is never collapsed to null:
 *  - not_found: the engine answered 404 (a real missing resource)
 *  - invalid: the engine answered 400/422; `message` is customer-readable
 *  - rate_limited: 429; `retryAfter` is seconds when the engine said so
 *  - unavailable: network error, timeout, 5xx, an unreadable body, or a
 *    credential problem the customer cannot fix
 */
export type Failure = {
  ok: false;
  kind: "not_found" | "invalid" | "rate_limited" | "unavailable";
  message?: string;
  retryAfter?: number;
};

export type Outcome<T> = { ok: true; data: T } | Failure;

/** Long enough for a cold engine, short enough that a hung one does not hold
 *  a page render open. */
const TIMEOUT_MS = 10_000;

const unavailable: Failure = { ok: false, kind: "unavailable" };

/** The engine's `detail` is a string for errors it raises itself and an array
 *  of field errors for request-shape validation (422). Only the former is
 *  written for customers. */
async function detailOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body.detail === "string" && body.detail.trim()
      ? body.detail.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

async function call<T>(
  path: string,
  init: RequestInit & { next?: { revalidate?: number | false } } = {},
): Promise<Outcome<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...engineHeaders(), ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return unavailable;
  }

  if (res.ok) {
    try {
      return { ok: true, data: (await res.json()) as T };
    } catch {
      return unavailable;
    }
  }

  if (res.status === 404) {
    return { ok: false, kind: "not_found", message: await detailOf(res) };
  }
  if (res.status === 400 || res.status === 422) {
    return { ok: false, kind: "invalid", message: await detailOf(res) };
  }
  if (res.status === 429) {
    const secs = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    return {
      ok: false,
      kind: "rate_limited",
      retryAfter: Number.isFinite(secs) && secs > 0 ? secs : undefined,
    };
  }
  // 5xx, and 401/403 (a misconfigured key is ours to fix, not the visitor's).
  return unavailable;
}

const get = <T>(path: string, revalidate = 3600) =>
  call<T>(path, { next: { revalidate } });

export type QuoteInput = {
  hts: string;
  country: string;
  value: number;
  byVessel?: boolean;
  formalEntry?: boolean;
  /** Special-rate program indicator (KR, S, AU...). Sent only when the
   *  customer states one; eligibility is never inferred. */
  preferenceProgram?: string;
};

export const getQuote = (q: QuoteInput) =>
  call<Quote>("/api/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hts: q.hts,
      country: q.country,
      value: q.value,
      by_vessel: q.byVessel ?? true,
      formal_entry: q.formalEntry ?? true,
      ...(q.preferenceProgram ? { preference_program: q.preferenceProgram } : {}),
    }),
    cache: "no-store",
  });

export const getHts = (code: string, country = "China", value = 10000) =>
  get<HtsDetail>(
    `/api/hts/${encodeURIComponent(code)}?country=${encodeURIComponent(country)}&value=${value}`,
  );

export const search = (q: string) =>
  get<{ query: string; results: { hts: string; description: string; full_path: string; general_rate: string }[] }>(
    `/api/search?q=${encodeURIComponent(q)}`,
    300,
  );

export const classify = (q: string) =>
  get<{ query: string; candidates: Candidate[]; reasoned: boolean; notes: string[] }>(
    `/api/classify?q=${encodeURIComponent(q)}`,
    300,
  );

export type ChangesFeed = {
  days: number;
  count: number;
  has_more?: boolean;
  changes: {
    document_number: string;
    title: string;
    doc_type: string;
    publication_date: string;
    html_url: string;
    abstract: string;
    hts_mentions: string[];
    tariff_action: boolean;
  }[];
};

export const getChanges = (days = 90, limit = 200) =>
  get<ChangesFeed>(`/api/changes?days=${days}&limit=${limit}`, 900);

/** Row counts are only returned to a keyed caller, so `counts` can be absent
 *  even when the engine is healthy. Callers must not read that as zero. */
export const getHealth = () =>
  get<{
    status: string;
    hts_edition?: string;
    counts?: Record<string, number>;
    reasoning_enabled?: boolean;
  }>("/api/health", 300);

/** Customer-facing wording for a failed call. Never mentions operators,
 *  pollers or configuration: a visitor cannot act on those. */
export function failureCopy(f: Failure): {
  title: string;
  body: string;
  retryable: boolean;
} {
  switch (f.kind) {
    case "not_found":
      return {
        title: "Not found",
        body: f.message ?? "We could not find that.",
        retryable: false,
      };
    case "invalid":
      return {
        title: "Check what you entered",
        body:
          f.message ??
          "Some of the values were not valid. Correct them and try again.",
        retryable: false,
      };
    case "rate_limited": {
      const wait = f.retryAfter
        ? `${f.retryAfter} second${f.retryAfter === 1 ? "" : "s"}`
        : "a minute";
      return {
        title: "Too many requests",
        body: `Please wait ${wait} and try again. What you entered is kept.`,
        retryable: true,
      };
    }
    case "unavailable":
      return {
        title: "Temporarily unavailable",
        body: "We could not reach the tariff data just now. What you entered is kept — try again in a minute.",
        retryable: true,
      };
  }
}

export const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const money2 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
