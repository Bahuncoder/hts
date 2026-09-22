/** Scenario calculator for costs that sit outside the tariff engine. */
export type LandedCostInputs = {
  freight: number;
  insurance: number;
  brokerage: number;
  portFees: number;
  other: number;
  /** Currency of additional costs only. Goods and tariff calculations are USD. */
  currency?: string;
  usdRate?: number;
  rateDate?: string;
  rateSource?: string;
  allocation?: "value" | "equal";
};

export type LandedCostResult = LandedCostInputs & {
  goods: number;
  duty: number;
  totalExtras: number;
  landed: number;
  landedRatePct: number;
  assumptions: LandedCostInputs;
};

export const COST_FIELDS = [
  ["freight", "Freight"], ["insurance", "Insurance"], ["brokerage", "Brokerage"],
  ["portFees", "Port and handling fees"], ["other", "Other costs"],
] as const;
export const EMPTY_COSTS: LandedCostInputs = { freight: 0, insurance: 0, brokerage: 0, portFees: 0, other: 0 };
export const MAX_COST = 1e9;
export const MAX_USD_RATE = 1000;
export const CURRENCIES = Intl.supportedValuesOf("currency");
export const ALLOCATION_METHODS = [{ value: "value", label: "By goods value" }, { value: "equal", label: "Equally per product line" }] as const;
export function parseCosts(value: unknown): LandedCostInputs {
  if (!value || typeof value !== "object") throw new Error("Enter valid import costs.");
  const result = { ...EMPTY_COSTS };
  for (const [key] of COST_FIELDS) {
    const n = (value as Record<string, unknown>)[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_COST || Math.abs(n * 100 - Math.round(n * 100)) > 0.0001) {
      throw new Error("Costs must be between 0 and 1,000,000,000 USD, with at most two decimal places.");
    }
    result[key] = n;
  }
  const raw = value as Record<string, unknown>;
  if (raw.currency !== undefined) {
    if (typeof raw.currency !== "string" || !CURRENCIES.includes(raw.currency)) throw new Error("Select a supported currency.");
    result.currency = raw.currency;
  }
  if (raw.allocation !== undefined) {
    if (raw.allocation !== "value" && raw.allocation !== "equal") throw new Error("Select an allocation method.");
    result.allocation = raw.allocation;
  }
  if ((result.currency ?? "USD") !== "USD") {
    if (typeof raw.usdRate !== "number" || !Number.isFinite(raw.usdRate) || raw.usdRate <= 0 || raw.usdRate > MAX_USD_RATE) throw new Error("Enter USD per one unit of the selected currency (greater than zero, up to 1,000).");
    if (typeof raw.rateDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.rateDate) || !Number.isFinite(Date.parse(raw.rateDate)) || new Date(raw.rateDate).toISOString().slice(0, 10) !== raw.rateDate) throw new Error("Enter the exchange-rate date.");
    if (typeof raw.rateSource !== "string" || !raw.rateSource.trim() || raw.rateSource.length > 200) throw new Error("Record the exchange-rate source (up to 200 characters).");
    result.usdRate = raw.usdRate;
    result.rateDate = raw.rateDate;
    result.rateSource = raw.rateSource.trim();
  } else if (raw.usdRate !== undefined && raw.usdRate !== 1) throw new Error("USD costs use an exchange rate of 1.");
  return result;
}
const finite = (n: number) => {
  if (!Number.isFinite(n) || n < 0) throw new Error("Invalid calculation amount.");
  return n;
};

export function landedCost(goods: number, duty: number, inputs: LandedCostInputs): LandedCostResult {
  const valid = parseCosts(inputs);
  const rate = (valid.currency ?? "USD") === "USD" ? 1 : valid.usdRate!;
  const convert = (n: number) => Math.round(finite(n) * rate * 100) / 100;
  const costs = {
    freight: convert(valid.freight), insurance: convert(valid.insurance),
    brokerage: convert(valid.brokerage), portFees: convert(valid.portFees),
    other: convert(valid.other),
  };
  const value = finite(goods);
  const tariff = finite(duty);
  const totalExtras = Object.values(costs).reduce((sum, n) => sum + Math.round(n * 100), 0) / 100;
  const landed = (Math.round(value * 100) + Math.round(tariff * 100) + Math.round(totalExtras * 100)) / 100;
  return { ...costs, goods: value, duty: tariff, totalExtras, landed, assumptions: valid,
    landedRatePct: value ? (landed / value) * 100 : 0 };
}

/** Largest-remainder distribution in integer cents; ties follow input order.
 * Zero total value falls back to equal shares rather than dividing by zero. */
export function allocateAmount(amount: number, weights: number[]): number[] {
  const cents = Math.round(finite(amount) * 100);
  if (!weights.length) return [];
  const sum = weights.reduce((a, b) => a + finite(b), 0);
  const shares = weights.map((w) => cents * (sum ? w / sum : 1 / weights.length));
  const result = shares.map(Math.floor);
  const order = shares.map((n, i) => ({ i, remainder: n - result[i] })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const left = cents - result.reduce((a, b) => a + b, 0);
  for (let i = 0; i < left; i++) result[order[i % order.length].i]++;
  return result.map((n) => n / 100);
}

export type AllocationLine = { id: string; sku: string | null; value: number; duty: number | null };
export function allocateCosts(lines: AllocationLine[], inputs: LandedCostInputs, mpf: number | null) {
  const result = landedCost(0, 0, inputs);
  const weights = lines.map((line) => inputs.allocation === "equal" ? 1 : line.value);
  const extra = allocateAmount(result.totalExtras, weights);
  const fees = allocateAmount(mpf ?? 0, weights);
  return lines.map((line, i) => ({
    id: line.id, sku: line.sku, goods: line.value, duty: line.duty,
    additional_costs: extra[i], mpf: fees[i],
    landed: line.duty === null || mpf === null ? null : Math.round((line.value + line.duty + extra[i] + fees[i]) * 100) / 100,
  }));
}
