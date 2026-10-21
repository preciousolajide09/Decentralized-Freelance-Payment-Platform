/**
 * activity.ts
 *
 * Turns the jobs an address takes part in into the summary the activity page
 * shows (issue #73): how many escrows are open, what has been released, and
 * how many jobs have completed.
 *
 * Kept pure and out of the page so the arithmetic is testable without a
 * wallet or a network — money is summed in integer base units (`bigint`) and
 * only formatted at the end, because adding decimals as JavaScript numbers is
 * how `0.1 + 0.2` becomes `0.30000000000000004` in a total.
 *
 * Contributor Notes:
 * - Released means the milestone row is `RELEASED`. The mirror has no partial
 *   amount, so a milestone that was released in part still counts as released
 *   in full here; the on-chain `released_amount` remains the authority.
 * - Amounts are totalled **per asset**: XLM and USDC cannot be added together.
 */

import { formatAmount, toBaseUnits, ASSETS } from "./assets";
import type { JobApi } from "./api";

/** Statuses in which the escrow still holds funds. */
const OPEN_STATUSES = new Set(["FUNDED", "ACTIVE", "DISPUTED"]);

const MILESTONE_RELEASED = "RELEASED";

/** A total for one asset, formatted at that asset's precision. */
export interface AssetTotal {
  symbol: string;
  /** Exact decimal string, e.g. `0.3`. */
  amount: string;
}

export interface ActivitySummary {
  /** Jobs the address is a party to, as client or freelancer. */
  totalJobs: number;
  /** Jobs currently holding funds in escrow. */
  activeEscrows: number;
  /** Jobs that reached `COMPLETED`. */
  completedJobs: number;
  /** Jobs taken on as the client. */
  asClient: number;
  /** Jobs taken on as the freelancer. */
  asFreelancer: number;
  /** Paid out / earned, per asset. */
  released: AssetTotal[];
  /** Still held in an open escrow, per asset. */
  locked: AssetTotal[];
}

/**
 * Decimals for an asset symbol, defaulting to 7 for a symbol this build does
 * not know (e.g. a job paid in an asset added to the backend but not here).
 * `getAsset` throws for an unknown symbol, which a read-only summary must not.
 */
function decimalsFor(symbol: string): number {
  return ASSETS.find((asset) => asset.symbol === symbol)?.decimals ?? 7;
}

/** The same job can only be listed once, even if a caller passes it twice. */
export function mergeJobs(...lists: JobApi[][]): JobApi[] {
  const byId = new Map<string, JobApi>();
  for (const job of lists.flat()) byId.set(job.id, job);
  return [...byId.values()];
}

function addTo(totals: Map<string, bigint>, symbol: string, base: bigint): void {
  totals.set(symbol, (totals.get(symbol) ?? 0n) + base);
}

/** Format each asset's base-unit total, in a stable order. */
function toAssetTotals(totals: Map<string, bigint>): AssetTotal[] {
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, base]) => ({ symbol, amount: formatAmount(base, decimalsFor(symbol)) }));
}

/**
 * Summarise the address's jobs.
 *
 * "Released" spans both roles on purpose — it is what the address has paid out
 * as a client and been paid as a freelancer — so the role counts are reported
 * alongside it rather than pretending the number means one of the two.
 *
 * A milestone can be partially released via `releasedAmount`: the amount
 * released so far. Only if `releasedAmount` equals `amount` (or status is
 * `RELEASED` with no `releasedAmount` set) is it fully released. Otherwise,
 * the released portion goes to released, and the remainder to locked (issue #175).
 */
export function summarizeActivity({
  asClient,
  asFreelancer,
}: {
  asClient: JobApi[];
  asFreelancer: JobApi[];
}): ActivitySummary {
  const jobs = mergeJobs(asClient, asFreelancer);
  const released = new Map<string, bigint>();
  const locked = new Map<string, bigint>();
  let activeEscrows = 0;
  let completedJobs = 0;

  for (const job of jobs) {
    const symbol = job.asset || "USDC";
    const decimals = decimalsFor(symbol);
    const isOpen = OPEN_STATUSES.has(job.status);

    if (isOpen) activeEscrows += 1;
    if (job.status === "COMPLETED") completedJobs += 1;

    for (const milestone of job.milestones ?? []) {
      const base = toBaseUnits(String(milestone.amount), decimals);
      
      // Account for partial releases: releasedAmount tracks actual payments
      const releasedAmountStr = milestone.releasedAmount
        ? String(milestone.releasedAmount)
        : milestone.status === MILESTONE_RELEASED
          ? String(milestone.amount)
          : "0";
      const releasedBase = toBaseUnits(releasedAmountStr, decimals);
      const lockedBase = base > releasedBase ? base - releasedBase : 0n;

      if (releasedBase > 0n) {
        addTo(released, symbol, releasedBase);
      }
      if (lockedBase > 0n && isOpen) {
        addTo(locked, symbol, lockedBase);
      }
    }
  }

  return {
    totalJobs: jobs.length,
    activeEscrows,
    completedJobs,
    asClient: asClient.length,
    asFreelancer: asFreelancer.length,
    released: toAssetTotals(released),
    locked: toAssetTotals(locked),
  };
}

const ACTION_LABELS: Record<string, string> = {
  created: "Escrow created",
  funded: "Escrow funded",
  milestones_updated: "Milestones updated",
  milestone_released: "Milestone released",
  dispute_opened: "Dispute opened",
  raised: "Dispute raised",
  approved: "Dispute approved",
  resolved: "Dispute resolved",
  dispute_resolved: "Dispute resolved",
  refunded: "Escrow refunded",
  rated: "Rating submitted",
};

/**
 * A readable label for an indexed event name. An event this build does not know
 * (a contract deployed ahead of the frontend) falls back to its name with the
 * underscores opened up rather than being hidden.
 */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

