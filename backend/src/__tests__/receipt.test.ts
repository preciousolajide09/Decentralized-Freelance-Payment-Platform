import { describe, expect, it } from "vitest";
import {
  buildEscrowReceipt,
  type ReceiptEvent,
  type ReceiptJob,
} from "../lib/receipt";

const GENERATED_AT = new Date("2026-03-01T09:00:00.000Z");

function job(overrides: Partial<ReceiptJob> = {}): ReceiptJob {
  return {
    id: "job-1",
    title: "Landing page redesign",
    description: "A new marketing site",
    status: "ACTIVE",
    asset: "USDC",
    totalAmount: "2.5",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2026-04-01T00:00:00.000Z"),
    client: { stellarAddress: "GCLIENT", displayName: "Ada" },
    freelancer: { stellarAddress: "GFREELANCER", displayName: null },
    milestones: [
      {
        index: 0,
        description: "Design",
        amount: "1.5",
        status: "RELEASED",
        deadline: new Date("2026-02-01T00:00:00.000Z"),
        releasedAt: new Date("2026-02-02T12:00:00.000Z"),
        releasedAmount: "1.5",
      },
      {
        index: 1,
        description: "Build",
        amount: "1",
        status: "PENDING",
        deadline: new Date("2026-03-01T00:00:00.000Z"),
        releasedAt: null,
        releasedAmount: "0",
      },
    ],
    ...overrides,
  };
}

function event(overrides: Partial<ReceiptEvent> = {}): ReceiptEvent {
  return {
    id: "evt-1",
    action: "funded",
    // Base units: 2.5 USDC at 7 decimals.
    amount: "25000000",
    txHash: "hash-funded",
    ledger: 10,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("buildEscrowReceipt", () => {
  it("renders the job, its milestones and the amounts in whole units", () => {
    const receipt = buildEscrowReceipt(7n, job(), [event()], GENERATED_AT);

    expect(receipt.escrowId).toBe("7");
    expect(receipt.generatedAt).toBe(GENERATED_AT.toISOString());
    expect(receipt.job).toMatchObject({
      id: "job-1",
      title: "Landing page redesign",
      asset: "USDC",
      totalAmount: "2.5",
      status: "ACTIVE",
      expiresAt: "2026-04-01T00:00:00.000Z",
      client: { stellarAddress: "GCLIENT", displayName: "Ada" },
    });
    expect(receipt.milestones).toEqual([
      {
        index: 0,
        description: "Design",
        amount: "1.5",
        status: "RELEASED",
        deadline: "2026-02-01T00:00:00.000Z",
        releasedAt: "2026-02-02T12:00:00.000Z",
      },
      {
        index: 1,
        description: "Build",
        amount: "1",
        status: "PENDING",
        deadline: "2026-03-01T00:00:00.000Z",
        releasedAt: null,
      },
    ]);
  });

  it("totals what has been released against what is still held", () => {
    // Summed in base units: a float sum here would print 3.4999999999999996 on a
    // document the client keeps.
    const receipt = buildEscrowReceipt(
      7n,
      job({
        totalAmount: "0.3",
        milestones: [
          { index: 0, description: null, amount: "0.1", status: "RELEASED", deadline: null, releasedAt: new Date(), releasedAmount: "0.1" },
          { index: 1, description: null, amount: "0.2", status: "RELEASED", deadline: null, releasedAt: new Date(), releasedAmount: "0.2" },
        ],
      }),
      [],
      GENERATED_AT,
    );

    expect(receipt.totals).toEqual({ released: "0.3", outstanding: "0" });
  });

  it("shows nothing released on an escrow whose milestones are all pending", () => {
    const receipt = buildEscrowReceipt(
      7n,
      job({ milestones: [{ index: 0, description: null, amount: "2.5", status: "PENDING", deadline: null, releasedAt: null, releasedAmount: "0" }] }),
      [],
      GENERATED_AT,
    );

    expect(receipt.totals).toEqual({ released: "0", outstanding: "2.5" });
  });

  it("clamps an over-released total to zero rather than going negative", () => {
    // Defensive: if the mirror ever recorded more released than the total, a
    // negative "outstanding" on a receipt would be worse than a zero.
    const receipt = buildEscrowReceipt(7n, job({ totalAmount: "1" }), [], GENERATED_AT);

    expect(receipt.totals).toEqual({ released: "1.5", outstanding: "0" });
  });

  it("lists the events oldest first with whole-unit amounts and transaction links", () => {
    const receipt = buildEscrowReceipt(
      7n,
      job(),
      [
        event({ id: "evt-2", action: "milestone_released", amount: "15000000", txHash: "hash-release", ledger: 20 }),
        event(),
        // An event that moves nothing keeps a null amount.
        event({ id: "evt-0", action: "created", amount: null, txHash: "hash-create", ledger: 5 }),
      ],
      GENERATED_AT,
    );

    expect(receipt.events.map((e) => [e.action, e.amount, e.txHash])).toEqual([
      ["created", null, "hash-create"],
      ["funded", "2.5", "hash-funded"],
      ["milestone_released", "1.5", "hash-release"],
    ]);
  });

  it("keeps a raw amount when the job's asset is not in the registry", () => {
    const receipt = buildEscrowReceipt(7n, job({ asset: "DOGE" }), [event()], GENERATED_AT);

    expect(receipt.events[0].amount).toBe("25000000");
  });
});
