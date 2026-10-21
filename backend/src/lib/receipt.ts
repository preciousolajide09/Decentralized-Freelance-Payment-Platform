/**
 * receipt.ts
 *
 * Assembles the per-escrow receipt issue #77 asks for: what was agreed, what was
 * released, and the transaction behind each step.
 *
 * Kept pure — plain row-shaped inputs and an injected clock, no Prisma or
 * `new Date()` of its own — so the totals and the shaping are unit-testable
 * without a database (see `__tests__/receipt.test.ts`).
 *
 * Money is summed in the asset's integer base units and rendered once, never as
 * JavaScript floats (see `sumAmounts` in lib/assets.ts): a receipt is the
 * artifact a client keeps for their records, so `0.1 + 0.2` must not appear on
 * it.
 */

import { formatAmount, formatBaseUnitsForAsset, getAsset, sumAmounts, toBaseUnits } from "./assets";

/** A milestone as the receipt needs it (Prisma's row satisfies this). */
export interface ReceiptMilestone {
  index: number;
  description: string | null;
  amount: unknown;
  status: string;
  deadline: Date | null;
  releasedAt: Date | null;
  /** Amount released so far for partial releases (issue #171). */
  releasedAmount: unknown;
}

/** A dispute as the receipt needs it. */
export interface ReceiptDispute {
  freelancerShare: unknown | null;
  clientShare: unknown | null;
}

/** The off-chain job behind an escrow, as the receipt needs it. */
export interface ReceiptJob {
  id: string;
  title: string;
  description: string;
  status: string;
  asset: string;
  totalAmount: unknown;
  createdAt: Date;
  expiresAt: Date | null;
  client: { stellarAddress: string; displayName: string | null } | null;
  freelancer: { stellarAddress: string; displayName: string | null } | null;
  milestones: ReceiptMilestone[];
  disputes?: ReceiptDispute[] | null;
}

/** An indexed contract event, as the receipt needs it (amount in base units). */
export interface ReceiptEvent {
  id: string;
  action: string;
  amount: unknown;
  txHash: string | null;
  ledger: number;
  createdAt: Date;
}

export interface EscrowReceipt {
  escrowId: string;
  generatedAt: string;
  job: {
    id: string;
    title: string;
    description: string;
    status: string;
    asset: string;
    totalAmount: string;
    createdAt: string;
    expiresAt: string | null;
    client: { stellarAddress: string; displayName: string | null } | null;
    freelancer: { stellarAddress: string; displayName: string | null } | null;
  };
  milestones: Array<{
    index: number;
    description: string | null;
    amount: string;
    status: string;
    deadline: string | null;
    releasedAt: string | null;
  }>;
  events: Array<{
    id: string;
    action: string;
    amount: string | null;
    txHash: string | null;
    ledger: number;
    createdAt: string;
  }>;
  totals: {
    /** Sum of the milestones the client has released. */
    released: string;
    /** What is still held by the escrow. */
    outstanding: string;
  };
}

/** Decimal places for the job's asset, falling back to 7 for an unknown SAC. */
function decimalsFor(asset: string): number {
  try {
    return getAsset(asset).decimals;
  } catch {
    return 7;
  }
}

/** A whole-unit amount normalized through base units, e.g. `2.50` → `2.5`. */
function normalizeAmount(amount: unknown, decimals: number): string {
  return formatAmount(toBaseUnits(String(amount), decimals), decimals);
}

/**
 * Build the receipt for one escrow from its off-chain job and its indexed
 * events. Events are returned oldest-first, which is the order a receipt reads
 * in.
 *
 * Released amount calculation (issue #171):
 * - If a milestone has `releasedAmount` set, use that (tracks partial releases)
 * - Otherwise, if status is `RELEASED`, use the full `amount`
 * - Otherwise, use 0
 *
 * Dispute resolution: If the job completed via dispute with a resolved share,
 * the freelancer received their portion and the client was refunded the rest.
 * The receipt reflects the amounts actually paid out, accounting for this split.
 */
export function buildEscrowReceipt(
  escrowId: bigint | number | string,
  job: ReceiptJob,
  events: ReceiptEvent[],
  generatedAt: Date = new Date(),
): EscrowReceipt {
  const decimals = decimalsFor(job.asset);

  // Calculate released amount accounting for partial releases and dispute resolution
  let releasedBase = 0n;
  for (const milestone of job.milestones) {
    // Use releasedAmount if available, otherwise check status for full release
    const releasedAmountStr = milestone.releasedAmount
      ? String(milestone.releasedAmount)
      : milestone.status === "RELEASED"
        ? String(milestone.amount)
        : "0";
    releasedBase += toBaseUnits(releasedAmountStr, decimals);
  }

  // If dispute was resolved with a split, the freelancer received their share
  // and the client was refunded. Adjust the released amount to reflect what
  // the freelancer actually received (freelancerShare of the released amount).
  const dispute = job.disputes?.[0];
  if (dispute && dispute.freelancerShare !== null && dispute.freelancerShare !== undefined) {
    const freelancerShare = toBaseUnits(String(dispute.freelancerShare), decimals);
    releasedBase = (releasedBase * freelancerShare) / toBaseUnits("100", decimals);
  }

  const totalBase = toBaseUnits(String(job.totalAmount), decimals);
  const outstandingBase = totalBase > releasedBase ? totalBase - releasedBase : 0n;

  return {
    escrowId: String(escrowId),
    generatedAt: generatedAt.toISOString(),
    job: {
      id: job.id,
      title: job.title,
      description: job.description,
      status: job.status,
      asset: job.asset,
      totalAmount: formatAmount(totalBase, decimals),
      createdAt: job.createdAt.toISOString(),
      expiresAt: job.expiresAt ? job.expiresAt.toISOString() : null,
      client: job.client,
      freelancer: job.freelancer,
    },
    milestones: job.milestones.map((milestone) => ({
      index: milestone.index,
      description: milestone.description,
      amount: normalizeAmount(milestone.amount, decimals),
      status: milestone.status,
      deadline: milestone.deadline ? milestone.deadline.toISOString() : null,
      releasedAt: milestone.releasedAt ? milestone.releasedAt.toISOString() : null,
    })),
    events: [...events]
      .sort((a, b) => a.ledger - b.ledger)
      .map((event) => ({
        id: event.id,
        action: event.action,
        amount:
          event.amount === null || event.amount === undefined
            ? null
            : formatBaseUnitsForAsset(String(event.amount), job.asset),
        txHash: event.txHash,
        ledger: event.ledger,
        createdAt: event.createdAt.toISOString(),
      })),
    totals: {
      released: formatAmount(releasedBase, decimals),
      outstanding: formatAmount(outstandingBase, decimals),
    },
  };
}
