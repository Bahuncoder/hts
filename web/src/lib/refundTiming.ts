/** CBP timing windows for a filed entry: Post Summary Correction (PSC),
 *  liquidation, and Protest. Pure date arithmetic, no engine or database
 *  access, so every branch can be tested directly against real calendar
 *  dates without a server.
 *
 *  Citations (verified against primary/secondary sources, not memorized):
 *   - PSC: filable up to 300 days after entry, and not within 15 days of the
 *     scheduled liquidation date, whichever is earlier -- 19 CFR 101.9(b).
 *   - Liquidation: CBP's normal cycle triggers around 314 days after entry;
 *     the statutory deadline (deemed liquidated at the importer's own
 *     declared rate if CBP does nothing) is one year after entry absent a
 *     suspension or extension -- 19 U.S.C. Sec. 1504(a).
 *   - Protest: must be filed within 180 days of the LIQUIDATION date (not
 *     the entry date) -- 19 U.S.C. Sec. 1514(c)(3), CBP Form 19. Courts
 *     treat this as jurisdictional; there is no late-filing exception.
 *
 *  Every branch below is worded as an estimate, never a determination: this
 *  tool has no access to CBP's actual record of a given entry, and AD/CVD
 *  suspensions or litigation routinely push real liquidation well past a
 *  year. `protestDeadline` is only ever a real date when a real liquidation
 *  date is supplied -- estimating it from entry_date alone would be one hop
 *  too speculative for a figure this consequential. */

const DAY_MS = 86_400_000;
const PSC_WINDOW_DAYS = 300;
const DEEMED_LIQUIDATION_DAYS = 365;
const PROTEST_WINDOW_DAYS = 180;

export const DISCLAIMER =
  "Estimated from standard statutory timelines, not confirmed against CBP's actual record of this entry. " +
  "Confirm with CBP or a licensed customs broker before relying on this for a filing.";

export type RefundTiming = {
  daysSinceEntry: number;
  pscEligible: string;
  pscDetail: string;
  /** An ISO date (liquidation_date + 180 days) when a real liquidation date
   *  was supplied, or a fixed "cannot be determined..." string otherwise --
   *  never estimated from entry_date alone. */
  protestDeadline: string;
  protestDetail: string;
  disclaimer: string;
};

const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / DAY_MS);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const CANNOT_DETERMINE = "cannot be determined without a liquidation date";

export function computeRefundTiming(
  entryDate: Date, liquidationDate: Date | null, today: Date = new Date(),
): RefundTiming {
  const daysSinceEntry = daysBetween(entryDate, today);

  if (!liquidationDate) {
    // Exactly 300 days already reads as "likely closed" -- a deliberately
    // conservative rounding. Telling someone they may still have time when
    // they don't is worse than telling them time is likely up when a few
    // days remain: the latter prompts a same-day check, the former invites
    // delay past a jurisdictional deadline.
    if (daysSinceEntry < PSC_WINDOW_DAYS) {
      return {
        daysSinceEntry,
        pscEligible: "may be available",
        pscDetail: "A Post Summary Correction may still be available (up to 300 days after entry, "
          + "and not within 15 days of the scheduled liquidation date -- 19 CFR 101.9(b)). "
          + "Confirm this entry has not already liquidated.",
        protestDeadline: CANNOT_DETERMINE,
        protestDetail: "The 180-day protest window (19 U.S.C. Sec. 1514(c)(3)) runs from the liquidation "
          + "date, not the entry date -- provide a liquidation date to check it.",
        disclaimer: DISCLAIMER,
      };
    }
    if (daysSinceEntry <= DEEMED_LIQUIDATION_DAYS) {
      return {
        daysSinceEntry,
        pscEligible: "likely closed",
        pscDetail: "The 300-day Post Summary Correction window (19 CFR 101.9(b)) has likely closed.",
        protestDeadline: CANNOT_DETERMINE,
        protestDetail: "Without a liquidation date, the 180-day protest window (19 U.S.C. Sec. 1514(c)(3)) "
          + "cannot be checked -- provide it, or confirm liquidation status with your broker.",
        disclaimer: DISCLAIMER,
      };
    }
    return {
      daysSinceEntry,
      pscEligible: "likely closed",
      pscDetail: "The 300-day Post Summary Correction window (19 CFR 101.9(b)) has likely closed.",
      protestDeadline: CANNOT_DETERMINE,
      protestDetail: "Absent a suspension, this entry would have deemed-liquidated at your declared rate "
        + "under 19 U.S.C. Sec. 1504(a). If so, a protest (180 days from the actual liquidation date, "
        + "CBP Form 19, 19 U.S.C. Sec. 1514(c)(3)) is the only remaining path, and may already have run -- "
        + "but this cannot be confirmed without your liquidation date.",
      disclaimer: DISCLAIMER,
    };
  }

  const daysSinceLiquidation = daysBetween(liquidationDate, today);
  if (daysSinceLiquidation < 0) {
    return {
      daysSinceEntry,
      pscEligible: "may be available until 15 days before the scheduled liquidation date",
      pscDetail: "This entry has not liquidated as of the date given, so a Post Summary Correction "
        + "(19 CFR 101.9(b)) may still be possible up until 15 days before liquidation.",
      protestDeadline: "not yet applicable -- this entry has not liquidated",
      protestDetail: "The 180-day protest clock (19 U.S.C. Sec. 1514(c)(3)) starts at liquidation, which "
        + "has not yet occurred on the date you gave.",
      disclaimer: DISCLAIMER,
    };
  }

  const deadline = new Date(liquidationDate.getTime() + PROTEST_WINDOW_DAYS * DAY_MS);
  const deadlineIso = isoDate(deadline);
  const open = daysSinceLiquidation <= PROTEST_WINDOW_DAYS;
  return {
    daysSinceEntry,
    pscEligible: "not available -- this entry has already liquidated",
    pscDetail: "Post Summary Correction is a pre-liquidation mechanism (19 CFR 101.9(b)); this entry's "
      + "liquidation date means it is no longer available.",
    protestDeadline: deadlineIso,
    protestDetail: open
      ? `The 180-day protest window (19 U.S.C. Sec. 1514(c)(3), CBP Form 19) is open, ending ${deadlineIso}.`
      : `The 180-day protest window (19 U.S.C. Sec. 1514(c)(3)) closed on ${deadlineIso}. Courts treat this `
        + "deadline as jurisdictional; no late filing is accepted.",
    disclaimer: DISCLAIMER,
  };
}
