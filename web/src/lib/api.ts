/** Server-side client for the Tariffwise API. */

export const API_BASE =
  process.env.TARIFFWISE_API ?? "http://127.0.0.1:8099";

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
  scope_unverified: string[];
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

async function get<T>(path: string, revalidate = 3600): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { next: { revalidate } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const getHts = (code: string, country = "China", value = 10000) =>
  get<HtsDetail>(
    `/api/hts/${code}?country=${encodeURIComponent(country)}&value=${value}`,
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

export const getChanges = (days = 90) =>
  get<{
    days: number;
    count: number;
    changes: {
      document_number: string;
      title: string;
      doc_type: string;
      publication_date: string;
      html_url: string;
      abstract: string;
      hts_mentions: string[];
    }[];
  }>(`/api/changes?days=${days}`, 900);

export const getHealth = () =>
  get<{
    status: string;
    hts_edition: string;
    counts: Record<string, number>;
    reasoning_enabled: boolean;
  }>("/api/health", 300);

export const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const money2 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
