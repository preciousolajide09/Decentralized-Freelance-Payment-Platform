import { describe, it, expect, vi } from "vitest";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { DisputeStatus, JobStatus, MilestoneStatus } from "@prisma/client";
import {
  decodeEventData,
  decodeEventFields,
  decodeEventName,
  type ContractEventLike,
} from "../lib/events";
import { FUNDED_JOB_STATUS } from "../lib/jobStatus";
import {
  EVENT_PAGE_LIMIT,
  EVENT_TOPIC_FIELDS,
  applyRatedEvent,
  buildChainEvent,
  dispatchEvent,
  handleCreated,
  handleFunded,
  handleDisputeOpened,
  handleMilestoneReleased,
  handleRaised,
  handleRefunded,
  processContractEvents,
  restoreDeadLetterEvent,
  resolveStartLedger,
  serializeDeadLetterEvent,
  type DisputeLifecycleStores,
  type IndexerStore,
  type MilestoneReleaseJob,
  type MilestoneReleaseStores,
  type RatedStores,
} from "../indexer";

/** Build an ScMap the way `#[contractevent]` data is encoded. */
function mapVal(entries: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(entries).map(
      ([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
    ),
  );
}

/**
 * Build an event the way the contracts do: the name in `topic[0]`, the struct's
 * `#[topic]` field(s) next, and everything else in the value map.
 */
function makeEvent(
  name: string,
  data: Record<string, xdr.ScVal>,
  ledger = 10,
  topics: xdr.ScVal[] = [],
): ContractEventLike {
  return {
    id: `evt-${ledger}`,
    ledger,
    topic: [xdr.ScVal.scvSymbol(name), ...topics],
    value: mapVal(data),
  };
}

/** Decode an event's fields the way `dispatchEvent` does, topic fields included. */
function eventFields(event: ContractEventLike): Record<string, unknown> {
  const name = decodeEventName(event) ?? "";
  return decodeEventFields(event, EVENT_TOPIC_FIELDS[name] ?? []);
}

/**
 * An event shaped the way the contracts publish one for their `#[topic]` field:
 * the escrow id is `topic[1]`, not part of the data map.
 */
function makeTopicEvent(
  name: string,
  escrowId: bigint,
  data: Record<string, xdr.ScVal> = {},
  ledger = 10,
): ContractEventLike {
  return {
    id: `evt-${ledger}`,
    ledger,
    topic: [xdr.ScVal.scvSymbol(name), nativeToScVal(escrowId, { type: "u64" })],
    value: mapVal(data),
  };
}

/**
 * Arbitrary fixture id — these tests never touch a chain, so it is deliberately
 * not a deployed contract. Live testnet ids live in deployments/testnet.json;
 * do not copy one in here, or this file starts looking like configuration.
 */
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const ALICE = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";

describe("event decoding", () => {
  it("restores the original event from its dead-letter payload", () => {
    const event = makeTopicEvent("milestones_updated", 7n, {
      count: nativeToScVal(2, { type: "u32" }),
    });
    const restored = restoreDeadLetterEvent(serializeDeadLetterEvent(event));

    expect(decodeEventName(restored)).toBe("milestones_updated");
    expect(eventFields(restored)).toEqual(eventFields(event));
  });

  it("decodes a captured milestone_released event", () => {
    const event = makeEvent("milestone_released", {
      escrow_id: nativeToScVal(7n, { type: "u64" }),
      index: nativeToScVal(0, { type: "u32" }),
      amount: nativeToScVal(300n, { type: "i128" }),
    });

    expect(decodeEventName(event)).toBe("milestone_released");
    expect(decodeEventData(event)).toMatchObject({
      escrow_id: 7n,
      index: 0,
      amount: 300n,
    });
  });

  it("decodes a captured rated event", () => {
    const ratee = Keypair.random().publicKey();
    const event = makeEvent("rated", {
      escrow_id: nativeToScVal(7n, { type: "u64" }),
      rater: Address.fromString(Keypair.random().publicKey()).toScVal(),
      ratee: Address.fromString(ratee).toScVal(),
      score: nativeToScVal(5, { type: "u32" }),
      count: nativeToScVal(1n, { type: "u64" }),
      total_score: nativeToScVal(5n, { type: "u64" }),
    });

    expect(decodeEventName(event)).toBe("rated");
    const data = decodeEventData(event);
    expect(data.ratee).toBe(ratee);
    expect(data.score).toBe(5);
    expect(data.count).toBe(1n);
    expect(data.total_score).toBe(5n);
  });

  it("returns null/empty for a malformed event instead of throwing", () => {
    const event = makeEvent("rated", {});
    expect(decodeEventName({ topic: [] })).toBeNull();
    expect(decodeEventData(event)).toEqual({});
  });

  it("reads a #[topic] field out of topic[1] on a captured testnet event", () => {
    // Captured from Soroban RPC testnet (tx 25bd0fb5b…): the dispute contract's
    // `Raised` marks escrow_id as #[topic], so it is in topic1 and the value map
    // holds only dispute_id and raised_by. Reading the value map alone — which
    // is what the indexer used to do — yields no escrow_id, so the handler
    // looked up nothing and the row's onChainId stayed null forever.
    const event = {
      ledger: 5_215_991,
      topic: [
        xdr.ScVal.fromXDR("AAAADwAAAAZyYWlzZWQAAA==", "base64"),
        xdr.ScVal.fromXDR("AAAABQAAAAAAAAAK", "base64"),
      ],
      value: xdr.ScVal.fromXDR(
        "AAAAEQAAAAEAAAACAAAADwAAAApkaXNwdXRlX2lkAAAAAAAFAAAAAAAAAAAAAAAPAAAACXJhaXNlZF9ieQAAAAAAABIAAAAAAAAAANGUF9btHFYS065a5qcfCrce1Lej1XjYw3pe/XrWguqR",
        "base64",
      ),
    };

    expect(decodeEventName(event)).toBe("raised");
    expect(decodeEventData(event).escrow_id).toBeUndefined();

    const fields = eventFields(event);
    expect(fields.escrow_id).toBe(10n);
    expect(fields.dispute_id).toBe(0n);
    expect(fields.raised_by).toBe("GDIZIF6W5UOFMEWTVZNONJY7BK3R5VFXUPKXRWGDPJPP26WWQLVJCRJG");
  });

  it("leaves an event whose escrow_id is a data field alone", () => {
    // escrow's `created`/`funded` put the client in topic1 and escrow_id in the
    // data, so the merge must not blank it.
    const event = makeEvent(
      "funded",
      { escrow_id: nativeToScVal(7n, { type: "u64" }), amount: nativeToScVal(3n, { type: "i128" }) },
      10,
      [Address.fromString(Keypair.random().publicKey()).toScVal()],
    );

    expect(EVENT_TOPIC_FIELDS.funded).toBeUndefined();
    expect(eventFields(event).escrow_id).toBe(7n);
  });
});

describe("chain event history (#72)", () => {
  /** An event as RPC returns it, including the transaction metadata. */
  function withMeta(
    event: ContractEventLike,
    txHash: string,
    ledgerClosedAt: string,
  ): ContractEventLike {
    return { ...event, txHash, ledgerClosedAt };
  }

  it("records the escrow, action, moved amount and transaction hash", () => {
    const event = withMeta(
      makeEvent(
        "milestone_released",
        {
          escrow_id: nativeToScVal(7n, { type: "u64" }),
          index: nativeToScVal(0, { type: "u32" }),
          amount: nativeToScVal(3_000_000n, { type: "i128" }),
        },
        42,
        [nativeToScVal(7n, { type: "u64" })],
      ),
      "abc123",
      "2026-01-02T03:04:05.000Z",
    );

    const row = buildChainEvent(event, "milestone_released", eventFields(event));

    expect(row).toMatchObject({
      // The RPC id, so a replayed event upserts the same row.
      id: "evt-42",
      escrowId: 7n,
      action: "milestone_released",
      // Base units, exactly as the contract emitted them.
      amount: "3000000",
      txHash: "abc123",
      ledger: 42,
    });
    expect(row?.createdAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("sums the two shares a resolution distributed", () => {
    const event = makeEvent("resolved", {
      escrow_id: nativeToScVal(7n, { type: "u64" }),
      client_share: nativeToScVal(500_000n, { type: "i128" }),
      freelancer_share: nativeToScVal(1_500_000n, { type: "i128" }),
    });

    expect(buildChainEvent(event, "resolved", eventFields(event))?.amount).toBe("2000000");
  });

  it("stores no amount for events that report a total rather than move funds", () => {
    // `created` carries the escrow total, which has not moved; showing it as an
    // amount would be misleading next to `funded`.
    const created = makeEvent("created", {
      escrow_id: nativeToScVal(7n, { type: "u64" }),
      total_amount: nativeToScVal(9_000_000n, { type: "i128" }),
    });

    expect(buildChainEvent(created, "created", eventFields(created))?.amount).toBeNull();
  });

  it("skips an event that belongs to no escrow", () => {
    // `approved` carries a dispute id in its topic and no escrow id, so there is
    // nothing to attach the row to.
    const approved = makeEvent(
      "approved",
      { arbitrator: Address.fromString(Keypair.random().publicKey()).toScVal() },
      10,
      [nativeToScVal(3n, { type: "u64" })],
    );

    expect(buildChainEvent(approved, "approved", eventFields(approved))).toBeNull();
  });

  it("composes a key for an event RPC gave no id, so a replayed batch is stable", () => {
    const event: ContractEventLike = {
      ledger: 5,
      topic: [xdr.ScVal.scvSymbol("funded"), nativeToScVal(7n, { type: "u64" })],
      value: mapVal({
        escrow_id: nativeToScVal(7n, { type: "u64" }),
        amount: nativeToScVal(1n, { type: "i128" }),
      }),
    };

    const first = buildChainEvent(event, "funded", eventFields(event));
    const second = buildChainEvent(event, "funded", eventFields(event));

    expect(first?.id).toBe("5-funded-7");
    expect(second?.id).toBe(first?.id);
  });
});

describe("processContractEvents", () => {
  it("advances the cursor only after every event has been processed", async () => {
    const order: string[] = [];
    const events = [
      makeEvent("funded", { escrow_id: nativeToScVal(7n, { type: "u64" }) }, 10),
      makeEvent(
        "milestone_released",
        { escrow_id: nativeToScVal(7n, { type: "u64" }), index: nativeToScVal(0, { type: "u32" }) },
        11,
      ),
    ];
    const source = {
      getEvents: vi.fn(async () => {
        order.push("getEvents");
        return { events, latestLedger: 12 };
      }),
    };

    let cursorValue = 5;
    const cursor = {
      get: async () => cursorValue,
      set: async (ledger: number) => {
        order.push(`set:${ledger}`);
        cursorValue = ledger;
      },
    };
    const dispatch = vi.fn(async () => {
      order.push("dispatch");
    });

    const next = await processContractEvents(source, cursor, [CONTRACT], dispatch);

    expect(source.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 6 }),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(next).toBe(12);
    expect(cursorValue).toBe(12);
    // Fetch first, dispatch in between, persist the cursor last.
    expect(order[0]).toBe("getEvents");
    expect(order[order.length - 1]).toBe("set:12");
  });

  it("paginates through multiple pages before advancing the cursor to the tip", async () => {
    const page1Events: ContractEventLike[] = Array.from({ length: EVENT_PAGE_LIMIT }, (_, i) => ({
      id: `evt-page1-${i}`,
      ledger: 10 + Math.floor(i / 20),
      topic: [xdr.ScVal.scvSymbol("funded")],
      value: mapVal({ escrow_id: nativeToScVal(BigInt(i), { type: "u64" }) }),
    }));
    const page2Events: ContractEventLike[] = Array.from({ length: 35 }, (_, i) => ({
      id: `evt-page2-${i}`,
      ledger: 15 + Math.floor(i / 20),
      topic: [xdr.ScVal.scvSymbol("funded")],
      value: mapVal({ escrow_id: nativeToScVal(BigInt(100 + i), { type: "u64" }) }),
    }));

    const requests: unknown[] = [];
    const source = {
      getEvents: vi.fn(async (req) => {
        requests.push(req);
        if (requests.length === 1) {
          return { events: page1Events, latestLedger: 20 };
        }
        return { events: page2Events, latestLedger: 20 };
      }),
    };

    let cursorValue = 5;
    const cursorOrder: string[] = [];
    const cursor = {
      get: async () => cursorValue,
      set: async (ledger: number) => {
        cursorOrder.push(`set:${ledger}`);
        cursorValue = ledger;
      },
    };

    const dispatched: string[] = [];
    const dispatch = vi.fn(async (event: ContractEventLike) => {
      dispatched.push(event.id!);
    });

    const next = await processContractEvents(source, cursor, [CONTRACT], dispatch);

    // Two pages fetched
    expect(source.getEvents).toHaveBeenCalledTimes(2);
    // First call uses startLedger
    expect(requests[0]).toMatchObject({ startLedger: 6, limit: EVENT_PAGE_LIMIT });
    // Second call uses pagination cursor from the last event of page 1
    expect(requests[1]).toMatchObject({
      cursor: `evt-page1-${EVENT_PAGE_LIMIT - 1}`,
      limit: EVENT_PAGE_LIMIT,
    });

    // All 135 events dispatched in exact order
    expect(dispatched).toHaveLength(EVENT_PAGE_LIMIT + 35);
    expect(dispatched[0]).toBe("evt-page1-0");
    expect(dispatched[EVENT_PAGE_LIMIT - 1]).toBe(`evt-page1-${EVENT_PAGE_LIMIT - 1}`);
    expect(dispatched[EVENT_PAGE_LIMIT]).toBe("evt-page2-0");
    expect(dispatched[EVENT_PAGE_LIMIT + 34]).toBe("evt-page2-34");

    // Cursor is only advanced ONCE, at the very end
    expect(cursorOrder).toEqual(["set:20"]);
    expect(cursorValue).toBe(20);
    expect(next).toBe(20);
  });

  it("handles pagination when event count is an exact multiple of page limit", async () => {
    const page1Events: ContractEventLike[] = Array.from({ length: EVENT_PAGE_LIMIT }, (_, i) => ({
      id: `evt-exact-${i}`,
      ledger: 10,
      topic: [xdr.ScVal.scvSymbol("funded")],
      value: mapVal({ escrow_id: nativeToScVal(BigInt(i), { type: "u64" }) }),
    }));

    const source = {
      getEvents: vi
        .fn()
        .mockResolvedValueOnce({ events: page1Events, latestLedger: 15 })
        .mockResolvedValueOnce({ events: [], latestLedger: 15 }),
    };

    let cursorValue = 5;
    const cursor = {
      get: async () => cursorValue,
      set: async (ledger: number) => {
        cursorValue = ledger;
      },
    };

    const dispatch = vi.fn();
    const next = await processContractEvents(source, cursor, [CONTRACT], dispatch);

    expect(source.getEvents).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(EVENT_PAGE_LIMIT);
    expect(cursorValue).toBe(15);
    expect(next).toBe(15);
  });

  it("advances startLedger across pages when events omit id", async () => {
    const page1Events: ContractEventLike[] = Array.from({ length: EVENT_PAGE_LIMIT }, (_, i) => ({
      ledger: 10,
      topic: [xdr.ScVal.scvSymbol("funded")],
      value: mapVal({ escrow_id: nativeToScVal(BigInt(i), { type: "u64" }) }),
    }));
    const page2Events: ContractEventLike[] = [
      {
        ledger: 11,
        topic: [xdr.ScVal.scvSymbol("funded")],
        value: mapVal({ escrow_id: nativeToScVal(1n, { type: "u64" }) }),
      },
    ];

    const requests: unknown[] = [];
    const source = {
      getEvents: vi.fn(async (req) => {
        requests.push(req);
        if (requests.length === 1) {
          return { events: page1Events, latestLedger: 12 };
        }
        return { events: page2Events, latestLedger: 12 };
      }),
    };

    let cursorValue = 5;
    const cursor = {
      get: async () => cursorValue,
      set: async (ledger: number) => {
        cursorValue = ledger;
      },
    };

    const dispatch = vi.fn();
    const next = await processContractEvents(source, cursor, [CONTRACT], dispatch);

    expect(source.getEvents).toHaveBeenCalledTimes(2);
    expect(requests[0]).toMatchObject({ startLedger: 6 });
    expect(requests[1]).toMatchObject({ startLedger: 11 });
    expect(dispatch).toHaveBeenCalledTimes(EVENT_PAGE_LIMIT + 1);
    expect(cursorValue).toBe(12);
    expect(next).toBe(12);
  });


  it("starts a fresh indexer inside the RPC's ledger window", async () => {
    // Ledger 1 is far outside what Soroban RPC retains, so a fresh cursor has to
    // start near the tip or every poll fails with `startLedger must be within
    // the ledger range`.
    const TIP = 5_090_272;
    const source = { getEvents: vi.fn(), getLatestLedger: async () => TIP };

    const start = await resolveStartLedger(source, 0);

    expect(start).toBe(TIP - 100);
    expect(start).toBeGreaterThan(TIP - 120_960);
  });

  it("resumes from the cursor when one exists", async () => {
    const source = { getEvents: vi.fn(), getLatestLedger: async () => 5_000_000 };

    expect(await resolveStartLedger(source, 4_999_990)).toBe(4_999_991);
  });

  it("clamps a cursor older than the RPC window instead of failing every poll", async () => {
    const TIP = 5_000_000;
    const source = { getEvents: vi.fn(), getLatestLedger: async () => TIP };
    const stale = TIP - 200_000;

    const start = await resolveStartLedger(source, stale);

    expect(start).toBe(TIP - 120_960 + 1);
    expect(start).toBeGreaterThan(stale + 1);
  });

  it("trusts the cursor when the source cannot report a chain tip", async () => {
    const source = { getEvents: vi.fn() };

    expect(await resolveStartLedger(source, 0)).toBe(1);
    expect(await resolveStartLedger(source, 42)).toBe(43);
  });

  it("still polls when reading the chain tip fails", async () => {
    const source = {
      getEvents: vi.fn(),
      getLatestLedger: async () => {
        throw new Error("rpc down");
      },
    };

    expect(await resolveStartLedger(source, 7)).toBe(8);
  });

  it("does not call getEvents when no contracts are configured", async () => {
    const source = { getEvents: vi.fn() };
    let cursorValue = 5;
    const cursor = {
      get: async () => cursorValue,
      set: async (ledger: number) => {
        cursorValue = ledger;
      },
    };

    const next = await processContractEvents(source, cursor, [], vi.fn());

    expect(next).toBe(5);
    expect(source.getEvents).not.toHaveBeenCalled();
  });

  it("dead-letters a failing event and keeps going", async () => {
    const events = [
      makeEvent("funded", { escrow_id: nativeToScVal(1n, { type: "u64" }) }, 10),
      makeEvent("refunded", { escrow_id: nativeToScVal(1n, { type: "u64" }) }, 11),
    ];
    const source = { getEvents: vi.fn(async () => ({ events, latestLedger: 11 })) };
    let cursorValue = 9;
    const cursor = {
      get: async () => cursorValue,
      set: async (ledger: number) => {
        cursorValue = ledger;
      },
    };
    const failure = new Error("boom");
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn(async () => undefined);

    await processContractEvents(source, cursor, [CONTRACT], dispatch, onError);

    // Only the failing event is dead-lettered, and it carries the cause.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(events[0], failure);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("still advances the cursor when the dead-letter store itself fails", async () => {
    const events = [makeEvent("funded", { escrow_id: nativeToScVal(1n, { type: "u64" }) }, 10)];
    const source = { getEvents: vi.fn(async () => ({ events, latestLedger: 10 })) };
    let cursorValue = 9;
    const cursor = {
      get: async () => cursorValue,
      set: async (ledger: number) => {
        cursorValue = ledger;
      },
    };
    const onError = vi.fn(async () => {
      throw new Error("database is down");
    });

    const next = await processContractEvents(
      source,
      cursor,
      [CONTRACT],
      vi.fn(async () => {
        throw new Error("boom");
      }),
      onError,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(next).toBe(10);
    expect(cursorValue).toBe(10);
  });

  it("keeps going when one event fails", async () => {
    const events = [
      makeEvent("funded", { escrow_id: nativeToScVal(1n, { type: "u64" }) }, 10),
      makeEvent("refunded", { escrow_id: nativeToScVal(1n, { type: "u64" }) }, 11),
    ];
    const source = { getEvents: vi.fn(async () => ({ events, latestLedger: 11 })) };
    let cursorValue = 9;
    const cursor = {
      get: async () => cursorValue,
      set: async (ledger: number) => {
        cursorValue = ledger;
      },
    };
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    // Stub the dead-letter store: this test is about dispatch, not persistence,
    // and the real store would need a database.
    const onError = vi.fn(async () => undefined);

    const next = await processContractEvents(source, cursor, [CONTRACT], dispatch, onError);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(next).toBe(11);
  });
});

describe("unlinked escrow events (issue #38)", () => {
  it("throws an error when handleCreated receives an unlinked escrow id", async () => {
    const store = {
      job: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as IndexerStore;

    await expect(handleCreated(999n, store)).rejects.toThrow(
      /unlinked escrow: no job found for escrow id 999/,
    );
  });

  it("throws an error when handleFunded receives an unlinked escrow id", async () => {
    const store = {
      job: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as IndexerStore;

    await expect(handleFunded(999n, store)).rejects.toThrow(
      /unlinked escrow: no job found for escrow id 999/,
    );
  });

  it("updates job status to CREATED and ACTIVE when escrow is linked", async () => {
    const updatedJobs: Array<{ where: any; data: any }> = [];
    const store = {
      job: {
        updateMany: vi.fn(async ({ where, data }) => {
          updatedJobs.push({ where, data });
          return { count: 1 };
        }),
      },
    } as unknown as IndexerStore;

    await handleCreated(7n, store);
    expect(updatedJobs).toContainEqual({
      where: { escrowId: 7n },
      data: { status: "CREATED" },
    });

    await handleFunded(7n, store);
    expect(updatedJobs).toContainEqual({
      where: { escrowId: 7n },
      // The route and the indexer read the same constant (issue #43).
      data: { status: FUNDED_JOB_STATUS },
    });
  });

  it("records dead letter when event arrives before escrow is linked, and succeeds when retried after link", async () => {
    // 1. Event arrives before escrow is linked:
    const event = makeEvent("funded", { escrow_id: nativeToScVal(42n, { type: "u64" }) }, 15);
    const source = { getEvents: vi.fn(async () => ({ events: [event], latestLedger: 15 })) };
    let cursorValue = 14;
    const cursor = {
      get: async () => cursorValue,
      set: async (ledger: number) => {
        cursorValue = ledger;
      },
    };

    let isLinked = false;
    let jobStatus = "PENDING";
    const store: IndexerStore = {
      job: {
        findUnique: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async ({ where, data }: any) => {
          if (isLinked && where.escrowId === 42n) {
            jobStatus = data.status;
            return { count: 1 };
          }
          return { count: 0 };
        }),
      } as any,
      milestone: { update: vi.fn(), updateMany: vi.fn() } as any,
      dispute: { updateMany: vi.fn(), upsert: vi.fn() } as any,
      user: { upsert: vi.fn() } as any,
      rating: { upsert: vi.fn() } as any,
    };

    const deadLetters: Array<{ event: ContractEventLike; error: unknown }> = [];
    const onError = vi.fn(async (evt, err) => {
      deadLetters.push({ event: evt, error: err });
    });

    // Run when not yet linked:
    await processContractEvents(
      source,
      cursor,
      [CONTRACT],
      (evt) => dispatchEvent(evt, store),
      onError,
    );

    // Event was recorded to dead letter, NOT silently discarded:
    expect(onError).toHaveBeenCalledTimes(1);
    expect(deadLetters).toHaveLength(1);
    expect(String(deadLetters[0].error)).toMatch(/unlinked escrow: no job found for escrow id 42/);
    expect(jobStatus).toBe("PENDING");

    // 2. Now the escrow is linked (e.g. through /api/escrow/sync):
    isLinked = true;

    // 3. Retry event:
    await dispatchEvent(event, store);

    // Job is now updated to ACTIVE:
    expect(jobStatus).toBe("ACTIVE");
  });
});

/**
 * In-memory stand-in for the store `applyRatedEvent` writes through, so the
 * "one row, no duplicate" property can be asserted without a database.
 */
class FakeRatedStore implements RatedStores {
  readonly jobs: Array<{ id: string; escrowId: bigint }> = [];
  readonly users = new Map<string, { id: string }>();
  readonly ratings = new Map<
    string,
    { jobId: string; raterId: string; rateeId: string; score: number }
  >();
  private seq = 0;

  private userId(address: string): { id: string } {
    let user = this.users.get(address);
    if (!user) {
      user = { id: `user-${++this.seq}` };
      this.users.set(address, user);
    }
    return user;
  }

  /** Pre-seed a user, as `POST /api/reputation` would have via `authenticate`. */
  seedUser(address: string): { id: string } {
    return this.userId(address);
  }

  /** Pre-seed the row `POST /api/reputation` writes before the tx lands. */
  seedRating(row: {
    jobId: string;
    raterId: string;
    rateeId: string;
    score: number;
  }): void {
    this.ratings.set(`${row.raterId}:${row.jobId}`, { ...row });
  }

  job = {
    findUnique: async ({ where }: { where: { escrowId: bigint } }) =>
      this.jobs.find((job) => job.escrowId === where.escrowId) ?? null,
  };

  user = {
    upsert: async ({ where }: { where: { stellarAddress: string } }) =>
      this.userId(where.stellarAddress),
  };

  rating = {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { raterId_jobId: { raterId: string; jobId: string } };
      create: { jobId: string; raterId: string; rateeId: string; score: number };
      update: { rateeId: string; score: number };
    }) => {
      const key = `${where.raterId_jobId.raterId}:${where.raterId_jobId.jobId}`;
      const existing = this.ratings.get(key);
      const next = existing ? { ...existing, ...update } : { ...create };
      this.ratings.set(key, next);
      return next;
    },
  };
}

describe("rated events", () => {
  const RATER = Keypair.random().publicKey();
  const RATEE = Keypair.random().publicKey();

  /**
   * The decoded payload of a `rated` event, as RPC would return it: the escrow
   * id is the `#[topic]` field, so it is *not* in the data map.
   */
  function ratedData(overrides: Record<string, xdr.ScVal> = {}) {
    return decodeEventData(
      makeTopicEvent("rated", 7n, {
        rater: Address.fromString(RATER).toScVal(),
        ratee: Address.fromString(RATEE).toScVal(),
        score: nativeToScVal(4, { type: "u32" }),
        count: nativeToScVal(1n, { type: "u64" }),
        total_score: nativeToScVal(4n, { type: "u64" }),
        ...overrides,
      }),
    );
  }

  it("creates exactly one Rating row from a rated event", async () => {
    const db = new FakeRatedStore();
    db.jobs.push({ id: "job-1", escrowId: 7n });

    const outcome = await applyRatedEvent(db, 7n, ratedData());

    expect(outcome).toEqual({ status: "applied", jobId: "job-1", score: 4 });
    expect(db.ratings.size).toBe(1);
    const [row] = [...db.ratings.values()];
    expect(row).toMatchObject({ jobId: "job-1", score: 4 });
    // Both participants were materialised, so the ratee resolves to a real row.
    expect(row.rateeId).toBe(db.seedUser(RATEE).id);
  });

  it("converges with a row POST /api/reputation already created instead of duplicating", async () => {
    const db = new FakeRatedStore();
    db.jobs.push({ id: "job-1", escrowId: 7n });
    const rater = db.seedUser(RATER);
    const ratee = db.seedUser(RATEE);
    // The API wrote the row (with a placeholder score) before the tx landed.
    db.seedRating({ jobId: "job-1", raterId: rater.id, rateeId: ratee.id, score: 1 });

    await applyRatedEvent(db, 7n, ratedData());

    expect(db.ratings.size).toBe(1);
    // The on-chain score wins — updated in place, not inserted twice.
    expect([...db.ratings.values()][0].score).toBe(4);
  });

  it("skips a rated event for an escrow that has no job record", async () => {
    const db = new FakeRatedStore();

    const outcome = await applyRatedEvent(db, 7n, ratedData());

    expect(outcome).toEqual({ status: "skipped", reason: "unknown-job" });
    expect(db.ratings.size).toBe(0);
    expect(db.users.size).toBe(0);
  });

  it("skips a malformed rated event without throwing", async () => {
    const db = new FakeRatedStore();

    const outcome = await applyRatedEvent(db, 7n, {});

    expect(outcome).toEqual({ status: "skipped", reason: "malformed" });
    expect(db.ratings.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Applying events to the database
// ---------------------------------------------------------------------------

interface FakeMilestone {
  id: string;
  index: number;
  status: "PENDING" | "RELEASED";
  releasedAt: Date | null;
  /** Human units, like the Prisma `Decimal` columns. */
  amount: string;
  releasedAmount: string;
  isStale: boolean;
}

interface FakeDispute {
  onChainId: bigint | null;
  jobId: string;
  raisedByAddress: string;
  reason: string;
  status: "RAISED" | "RESOLVED";
  resolvedAt: Date | null;
}

interface FakeJob {
  id: string;
  escrowId: bigint;
  asset: string;
  status: string;
  totalAmount: string;
  milestones: FakeMilestone[];
  disputes: FakeDispute[];
}

function fakeJob(overrides: Partial<FakeJob> = {}): FakeJob {
  return {
    id: "job_1",
    escrowId: 7n,
    asset: "USDC",
    status: "CREATED",
    totalAmount: "1",
    milestones: [
      {
        id: "m0",
        index: 0,
        status: "PENDING",
        releasedAt: null,
        amount: "0.5",
        releasedAmount: "0",
        isStale: false,
      },
      {
        id: "m1",
        index: 1,
        status: "PENDING",
        releasedAt: null,
        amount: "0.5",
        releasedAmount: "0",
        isStale: false,
      },
    ],
    disputes: [],
    ...overrides,
  };
}

/** The `where` clauses the handlers actually use. */
type FakeWhere = {
  escrowId?: bigint | null;
  id?: string;
  jobId?: string;
  job?: { escrowId: bigint | null };
};

interface FakeRatingRow {
  jobId: string;
  raterId: string;
  rateeId: string;
  score: number;
}

/**
 * In-memory stand-in for the slice of Prisma the handlers write through, so a
 * test can run a real event sequence and assert the rows it produces. Only the
 * access patterns the handlers use are implemented: `id`/`escrowId` lookups, the
 * `job: { escrowId }` relation filter, the dispute upsert, and the rating
 * upsert keyed by `(rater, job)`. Rating rows land in `ratings` so a test can
 * assert them. The cast at the end hides Prisma's own promise type, which the
 * fake has no need to reproduce.
 */
function makeStore(jobs: FakeJob[], ratings: FakeRatingRow[] = []): IndexerStore {
  const byId = (id: string) => jobs.find((job) => job.id === id);
  const byEscrow = (escrowId: bigint | null) => jobs.filter((job) => job.escrowId === escrowId);
  const related = <T>(where: FakeWhere, pick: (job: FakeJob) => T[]): T[] =>
    jobs
      .filter((job) =>
        where.jobId ? job.id === where.jobId : job.escrowId === where.job?.escrowId,
      )
      .flatMap(pick);

  return {
    job: {
      findUnique: async ({ where, include }: { where: FakeWhere; include?: { milestones?: boolean } }) => {
        const job = where.id ? byId(where.id) : byEscrow(where.escrowId ?? null)[0];
        if (!job) return null;
        return include?.milestones ? job : { ...job, milestones: undefined };
      },
      update: async ({ where, data }: { where: FakeWhere; data: Partial<FakeJob> }) => {
        const job = byId(where.id as string);
        if (!job) throw new Error(`no job ${where.id}`);
        Object.assign(job, data);
        return job;
      },
      updateMany: async ({ where, data }: { where: FakeWhere; data: Partial<FakeJob> }) => {
        const matched = byEscrow(where.escrowId ?? null);
        for (const job of matched) Object.assign(job, data);
        return { count: matched.length };
      },
    },
    milestone: {
      update: async ({ where, data }: { where: FakeWhere; data: Partial<FakeMilestone> }) => {
        const milestone = jobs
          .flatMap((job) => job.milestones)
          .find((m) => m.id === where.id);
        if (!milestone) throw new Error(`no milestone ${where.id}`);
        Object.assign(milestone, data);
        return milestone;
      },
      updateMany: async ({ where, data }: { where: FakeWhere; data: Partial<FakeMilestone> }) => {
        const matched = related(where, (job) => job.milestones);
        for (const milestone of matched) Object.assign(milestone, data);
        return { count: matched.length };
      },
    },
    dispute: {
      updateMany: async ({ where, data }: { where: FakeWhere; data: Partial<FakeDispute> }) => {
        const matched = related(where, (job) => job.disputes);
        for (const dispute of matched) Object.assign(dispute, data);
        return { count: matched.length };
      },
      upsert: async ({
        where,
        create,
      }: {
        where: { onChainId?: bigint; jobId?: string };
        create: Partial<FakeDispute> & { jobId: string };
      }) => {
        const existing = jobs
          .flatMap((job) => job.disputes)
          .find((dispute) =>
            where.jobId ? dispute.jobId === where.jobId : dispute.onChainId === where.onChainId,
          );
        if (existing) {
          if (create.onChainId !== undefined) existing.onChainId = create.onChainId;
          if (create.raisedByAddress) existing.raisedByAddress = create.raisedByAddress;
          return existing;
        }
        const job = byId(create.jobId);
        if (!job) throw new Error(`no job ${create.jobId}`);
        const created: FakeDispute = {
          onChainId: create.onChainId ?? null,
          jobId: create.jobId,
          raisedByAddress: create.raisedByAddress ?? "",
          reason: create.reason ?? "",
          status: create.status ?? "RAISED",
          resolvedAt: create.resolvedAt ?? null,
        };
        job.disputes.push(created);
        return created;
      },
    },
    user: {
      upsert: async ({ where }: { where: { stellarAddress: string } }) => ({
        id: `user_${where.stellarAddress}`,
      }),
    },
    rating: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { raterId_jobId: { raterId: string; jobId: string } };
        create: FakeRatingRow;
        update: { rateeId: string; score: number };
      }) => {
        const existing = ratings.find(
          (row) =>
            row.raterId === where.raterId_jobId.raterId &&
            row.jobId === where.raterId_jobId.jobId,
        );
        if (existing) Object.assign(existing, update);
        else ratings.push({ ...create });
        return {};
      },
    },
  } as unknown as IndexerStore;
}

describe("dispatchEvent", () => {
  it("moves the job to ACTIVE on funded, whose id is in the data map", async () => {
    const jobs = [fakeJob()];

    await dispatchEvent(
      makeEvent("funded", { escrow_id: nativeToScVal(7n, { type: "u64" }) }),
      makeStore(jobs),
    );

    expect(jobs[0].status).toBe("ACTIVE");
  });

  it("releases a milestone whose escrow id is only in the event topic", async () => {
    const jobs = [fakeJob({ status: "ACTIVE" })];

    await dispatchEvent(
      makeTopicEvent("milestone_released", 7n, {
        index: nativeToScVal(0, { type: "u32" }),
        amount: nativeToScVal(5_000_000n, { type: "i128" }),
      }),
      makeStore(jobs),
    );

    expect(jobs[0].milestones[0].status).toBe("RELEASED");
    expect(jobs[0].milestones[0].releasedAt).toBeInstanceOf(Date);
    // The other milestone is still pending, so the job is not done yet.
    expect(jobs[0].milestones[1].status).toBe("PENDING");
    expect(jobs[0].status).toBe("ACTIVE");
  });

  it("completes the job once the last milestone is released", async () => {
    const jobs = [fakeJob({ status: "ACTIVE" })];
    const store = makeStore(jobs);

    for (const index of [0, 1]) {
      await dispatchEvent(
        makeTopicEvent("milestone_released", 7n, {
          index: nativeToScVal(index, { type: "u32" }),
          amount: nativeToScVal(5_000_000n, { type: "i128" }),
        }),
        store,
      );
    }

    expect(jobs[0].milestones.map((m) => m.status)).toEqual(["RELEASED", "RELEASED"]);
    expect(jobs[0].status).toBe("COMPLETED");
  });

  it("marks the job DISPUTED when a dispute is opened", async () => {
    const jobs = [fakeJob({ status: "ACTIVE" })];

    await dispatchEvent(makeTopicEvent("dispute_opened", 7n), makeStore(jobs));

    expect(jobs[0].status).toBe("DISPUTED");
  });

  it("settles the milestones too when the escrow is resolved", async () => {
    // `escrow.resolve` pays out in one transaction and emits only `resolved`,
    // so no per-milestone events follow. Left unhandled, an arbitrated job
    // would be COMPLETED while its milestones stayed PENDING forever.
    const jobs = [
      fakeJob({
        status: "DISPUTED",
        disputes: [
          {
            onChainId: 3n,
            jobId: "job_1",
            raisedByAddress: ALICE,
            reason: "",
            status: "RAISED",
            resolvedAt: null,
          },
        ],
      }),
    ];

    await dispatchEvent(
      makeTopicEvent("resolved", 7n, {
        client_share: nativeToScVal(0n, { type: "i128" }),
        freelancer_share: nativeToScVal(20_000_000n, { type: "i128" }),
      }),
      makeStore(jobs),
    );

    expect(jobs[0].status).toBe("COMPLETED");
    expect(jobs[0].disputes[0]).toMatchObject({ status: "RESOLVED" });
    expect(jobs[0].milestones.map((m) => m.status)).toEqual(["RELEASED", "RELEASED"]);
    // `escrow.resolve` sets every on-chain milestone's released_amount to its
    // full amount; the mirror has to do the same, or a resolved escrow's
    // milestones look RELEASED while having paid out nothing (issue #168).
    expect(jobs[0].milestones.map((m) => m.releasedAmount)).toEqual(["0.5", "0.5"]);
    // One transaction on-chain, so one instant off-chain.
    expect(jobs[0].milestones.map((m) => m.releasedAt)).toEqual([
      jobs[0].disputes[0].resolvedAt,
      jobs[0].disputes[0].resolvedAt,
    ]);
    expect(jobs[0].disputes[0].resolvedAt).toBeInstanceOf(Date);
  });

  it("overwrites a part-released milestone's amount when the dispute resolves", async () => {
    // A milestone can be paid down before the dispute freezes the escrow. The
    // resolution is terminal and the contract marks it fully released, so the
    // mirror must replace the running total with the milestone's full amount
    // rather than leave the partial value behind.
    const jobs = [
      fakeJob({
        status: "DISPUTED",
        milestones: [
          {
            id: "m0",
            index: 0,
            status: "PENDING",
            releasedAt: null,
            amount: "10",
            releasedAmount: "4",
            isStale: false,
          },
        ],
      }),
    ];

    await dispatchEvent(makeTopicEvent("resolved", 7n), makeStore(jobs));

    expect(jobs[0].milestones[0]).toMatchObject({
      status: "RELEASED",
      releasedAmount: "10",
    });
  });

  it("treats dispute_resolved like resolved", async () => {
    const jobs = [fakeJob({ status: "DISPUTED" })];

    await dispatchEvent(makeTopicEvent("dispute_resolved", 7n), makeStore(jobs));

    expect(jobs[0].status).toBe("COMPLETED");
    expect(jobs[0].milestones[0].status).toBe("RELEASED");
    expect(jobs[0].milestones[0].releasedAmount).toBe("0.5");
  });

  it("refunds the job, leaving the milestones untouched", async () => {
    const jobs = [fakeJob({ status: "ACTIVE" })];

    await dispatchEvent(makeTopicEvent("refunded", 7n), makeStore(jobs));

    expect(jobs[0].status).toBe("REFUNDED");
    expect(jobs[0].milestones[0].status).toBe("PENDING");
  });

  it("reconciles the total and marks a mismatched milestone breakdown stale", async () => {
    const jobs = [fakeJob({ asset: "XLM", totalAmount: "1" })];

    await dispatchEvent(
      makeTopicEvent("milestones_updated", 7n, {
        count: nativeToScVal(2, { type: "u32" }),
        total_amount: nativeToScVal(25_000_000n, { type: "i128" }),
      }),
      makeStore(jobs),
    );

    expect(jobs[0].totalAmount).toBe("2.5");
    expect(jobs[0].milestones.every((milestone) => milestone.isStale)).toBe(true);
  });

  it("keeps a milestone breakdown current when its count and total match the event", async () => {
    const jobs = [fakeJob({ totalAmount: "1" })];

    await dispatchEvent(
      makeTopicEvent("milestones_updated", 7n, {
        count: nativeToScVal(2, { type: "u32" }),
        total_amount: nativeToScVal(10_000_000n, { type: "i128" }),
      }),
      makeStore(jobs),
    );

    expect(jobs[0].totalAmount).toBe("1");
    expect(jobs[0].milestones.every((milestone) => !milestone.isStale)).toBe(true);
  });

  it("ignores a milestones_updated total of zero", async () => {
    const jobs = [fakeJob({ totalAmount: "1" })];

    await dispatchEvent(
      makeTopicEvent("milestones_updated", 7n, {
        count: nativeToScVal(0, { type: "u32" }),
        total_amount: nativeToScVal(0n, { type: "i128" }),
      }),
      makeStore(jobs),
    );

    expect(jobs[0].totalAmount).toBe("1");
  });

  it("records a raised dispute once, even when the event is replayed", async () => {
    const jobs = [fakeJob()];
    const store = makeStore(jobs);
    const event = makeTopicEvent("raised", 7n, {
      dispute_id: nativeToScVal(3n, { type: "u64" }),
      raised_by: Address.fromString(ALICE).toScVal(),
    });

    await dispatchEvent(event, store);
    await dispatchEvent(event, store);

    expect(jobs[0].disputes).toEqual([
      {
        onChainId: 3n,
        jobId: "job_1",
        raisedByAddress: ALICE,
        reason: "",
        status: "RAISED",
        resolvedAt: null,
      },
    ]);
  });

  it("writes nothing for an event it cannot attribute to an escrow", async () => {
    const jobs = [fakeJob()];
    const before = structuredClone(jobs);

    await dispatchEvent(
      makeEvent("milestone_released", { index: nativeToScVal(0, { type: "u32" }) }),
      makeStore(jobs),
    );

    expect(jobs).toEqual(before);
  });

  it("ignores an event name it does not know", async () => {
    const jobs = [fakeJob()];
    const before = structuredClone(jobs);

    await dispatchEvent(makeTopicEvent("something_new", 7n), makeStore(jobs));

    expect(jobs).toEqual(before);
  });

  it("stores a rating whose escrow id is only in the event topic", async () => {
    // `rated` carries escrow_id as its #[topic] field. Reading it from the data
    // map instead made every real rating event look malformed, so ratings made
    // with `stellar contract invoke` never reached the database.
    const rater = Keypair.random().publicKey();
    const ratee = Keypair.random().publicKey();
    const ratings: FakeRatingRow[] = [];

    await dispatchEvent(
      makeTopicEvent("rated", 7n, {
        rater: Address.fromString(rater).toScVal(),
        ratee: Address.fromString(ratee).toScVal(),
        score: nativeToScVal(4, { type: "u32" }),
      }),
      makeStore([fakeJob()], ratings),
    );

    expect(ratings).toEqual([
      {
        jobId: "job_1",
        raterId: `user_${rater}`,
        rateeId: `user_${ratee}`,
        score: 4,
      },
    ]);
  });

  it("ignores a rated event with no escrow id", async () => {
    const ratings: FakeRatingRow[] = [];

    await dispatchEvent(
      makeEvent("rated", {
        rater: Address.fromString(Keypair.random().publicKey()).toScVal(),
        ratee: Address.fromString(Keypair.random().publicKey()).toScVal(),
        score: nativeToScVal(4, { type: "u32" }),
      }),
      makeStore([fakeJob()], ratings),
    );

    expect(ratings).toEqual([]);
  });

  it("leaves an event for an unknown escrow alone", async () => {
    const jobs = [fakeJob()];
    const before = structuredClone(jobs);

    await dispatchEvent(makeTopicEvent("refunded", 999n), makeStore(jobs));

    expect(jobs).toEqual(before);
  });
});

/**
 * In-memory stand-in for the store the dispute-lifecycle handlers write through,
 * so `dispute_opened → raised → refunded` can be driven end to end without a
 * database (the same approach as `FakeRatedStore`).
 */
class FakeDisputeStore implements DisputeLifecycleStores {
  private readonly jobs = new Map<bigint, { id: string; status: JobStatus }>();
  // Keyed on the job, mirroring the unique constraint the real table has.
  private readonly disputes = new Map<
    string,
    {
      onChainId: bigint | null;
      jobId: string;
      raisedByAddress: string;
      reason: string;
      status: DisputeStatus;
      resolvedAt: Date | null;
    }
  >();
  private seq = 0;

  /** Seed the mirrored job for an escrow and return its id. */
  seedJob(escrowId: bigint): string {
    const id = `job-${++this.seq}`;
    this.jobs.set(escrowId, { id, status: "CREATED" });
    return id;
  }

  jobStatus(escrowId: bigint): JobStatus | undefined {
    return this.jobs.get(escrowId)?.status;
  }

  disputeRows(): Array<{
    onChainId: bigint | null;
    jobId: string;
    raisedByAddress: string;
    reason: string;
    status: DisputeStatus;
    resolvedAt: Date | null;
  }> {
    return [...this.disputes.values()];
  }

  /** Pre-seed a dispute row, e.g. one an arbitrator had already picked up. */
  seedDispute(escrowId: bigint, status: DisputeStatus): void {
    const job = this.jobs.get(escrowId);
    if (!job) throw new Error("seed the job first");
    this.disputes.set(job.id, {
      onChainId: BigInt(++this.seq),
      jobId: job.id,
      raisedByAddress: "GRAISER",
      reason: "",
      status,
      resolvedAt: status === "RESOLVED" ? new Date() : null,
    });
  }

  /**
   * Pre-seed the row `POST /api/disputes` writes: the reason is known, the
   * on-chain id is not (the contract has not minted one yet).
   */
  seedIntentRow(escrowId: bigint, reason: string): void {
    const job = this.jobs.get(escrowId);
    if (!job) throw new Error("seed the job first");
    this.disputes.set(job.id, {
      onChainId: null,
      jobId: job.id,
      // Whoever called the API — which is not necessarily whoever raised it.
      raisedByAddress: "GWHO_RECORDED_IT",
      reason,
      status: "RAISED",
      resolvedAt: null,
    });
  }

  job = {
    findUnique: async ({ where }: { where: { escrowId: bigint } }) => {
      const job = this.jobs.get(where.escrowId);
      return job ? { id: job.id } : null;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { escrowId: bigint };
      data: { status: JobStatus };
    }) => {
      const job = this.jobs.get(where.escrowId);
      if (job) job.status = data.status;
      return { count: job ? 1 : 0 };
    },
  };

  dispute = {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { jobId: string };
      create: {
        onChainId: bigint;
        jobId: string;
        raisedByAddress: string;
        reason: string;
      };
      update: { onChainId: bigint };
    }) => {
      const existing = this.disputes.get(where.jobId);
      // Updating the row the API already created, rather than inserting a second
      // one, is the whole point of keying on the job.
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row = { ...create, status: "RAISED" as DisputeStatus, resolvedAt: null };
      this.disputes.set(where.jobId, row);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { job: { escrowId: bigint }; status: { in: DisputeStatus[] } };
      data: { status: DisputeStatus; resolvedAt: Date };
    }) => {
      const job = this.jobs.get(where.job.escrowId);
      if (!job) return { count: 0 };
      let count = 0;
      for (const row of this.disputes.values()) {
        if (row.jobId === job.id && where.status.in.includes(row.status)) {
          row.status = data.status;
          row.resolvedAt = data.resolvedAt;
          count++;
        }
      }
      return { count };
    },
  };
}

describe("dispute lifecycle events", () => {
  const CLIENT = Keypair.random().publicKey();

  /**
   * Decode a real event payload, so the handlers see what the chain emits —
   * including the `escrow_id` that these events carry in topic1.
   */
  function eventData(
    name: string,
    fields: Record<string, xdr.ScVal>,
    escrowId = 7n,
  ): Record<string, unknown> {
    return eventFields(
      makeEvent(name, fields, 10, [nativeToScVal(escrowId, { type: "u64" })]),
    );
  }

  const disputeOpened = () =>
    eventData("dispute_opened", { initiator: Address.fromString(CLIENT).toScVal() });

  const raised = () =>
    eventData("raised", {
      dispute_id: nativeToScVal(3n, { type: "u64" }),
      raised_by: Address.fromString(CLIENT).toScVal(),
    });

  const refunded = (escrowId = 7n) =>
    eventData(
      "refunded",
      {
        client: Address.fromString(CLIENT).toScVal(),
        amount: nativeToScVal(20_000_000n, { type: "i128" }),
      },
      escrowId,
    );

  it("drives dispute_opened → raised → refunded and leaves no open dispute", async () => {
    const db = new FakeDisputeStore();
    const jobId = db.seedJob(7n);

    // 1. open_dispute freezes the job. The dispute row does not exist yet: the
    //    on-chain dispute has no id until `raise` (documented in indexer.ts).
    await handleDisputeOpened(db, disputeOpened());
    expect(db.jobStatus(7n)).toBe("DISPUTED");
    expect(db.disputeRows()).toHaveLength(0);

    // 2. dispute.raise records the on-chain dispute against the job.
    await handleRaised(db, raised());
    expect(db.disputeRows()).toHaveLength(1);
    expect(db.disputeRows()[0]).toMatchObject({
      onChainId: 3n,
      jobId,
      status: "RAISED",
      resolvedAt: null,
    });

    // 3. reclaim_after_dispute_timeout refunds the escrow and closes the dispute.
    await handleRefunded(db, refunded());

    expect(db.jobStatus(7n)).toBe("REFUNDED");
    const rows = db.disputeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("REFUNDED");
    expect(rows[0].resolvedAt).toBeInstanceOf(Date);
    // No dispute for the escrow is left open.
    expect(rows.filter((row) => row.status === "RAISED" || row.status === "UNDER_REVIEW"))
      .toHaveLength(0);
  });

  it("converges the API's off-chain row with the raised event instead of duplicating it", async () => {
    const db = new FakeDisputeStore();
    const jobId = db.seedJob(7n);
    // `POST /api/disputes` recorded the reason before dispute.raise ran.
    db.seedIntentRow(7n, "Milestone never delivered");

    await handleDisputeOpened(db, disputeOpened());
    await handleRaised(db, raised());

    // One row, holding both the reason and the id. Keying the upsert on
    // `onChainId` (as this handler used to) inserted a second row here, and the
    // resolve route then failed forever on the row whose id stayed null.
    const rows = db.disputeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      jobId,
      onChainId: 3n,
      reason: "Milestone never delivered",
      status: "RAISED",
      // The event's raiser is authoritative: the contract checked that
      // `raised_by` is a party, while the row only knows who called the API.
      raisedByAddress: CLIENT,
    });
  });

  it("stays one row when the same raised event is indexed twice", async () => {
    const db = new FakeDisputeStore();
    db.seedJob(7n);
    db.seedIntentRow(7n, "Milestone never delivered");

    // A cursor rewind replays the event; the row must not multiply, and
    // re-writing the same values must not disturb the stored reason.
    await handleRaised(db, raised());
    await handleRaised(db, raised());

    expect(db.disputeRows()).toHaveLength(1);
    expect(db.disputeRows()[0]).toMatchObject({
      onChainId: 3n,
      reason: "Milestone never delivered",
    });
  });

  it("closes an UNDER_REVIEW dispute too (an arbitrator had started)", async () => {
    const db = new FakeDisputeStore();
    db.seedJob(7n);
    db.seedDispute(7n, "UNDER_REVIEW");

    await handleRefunded(db, refunded());

    expect(db.jobStatus(7n)).toBe("REFUNDED");
    expect(db.disputeRows()[0].status).toBe("REFUNDED");
    expect(db.disputeRows()[0].resolvedAt).toBeInstanceOf(Date);
  });

  it("leaves a dispute the panel already resolved untouched", async () => {
    const db = new FakeDisputeStore();
    db.seedJob(7n);
    db.seedDispute(7n, "RESOLVED");

    await handleRefunded(db, refunded());

    expect(db.jobStatus(7n)).toBe("REFUNDED");
    expect(db.disputeRows()[0].status).toBe("RESOLVED");
  });

  it("refunds an escrow that was never disputed without inventing a dispute", async () => {
    const db = new FakeDisputeStore();
    db.seedJob(9n);

    // reclaim_expired runs from Active, so there is no dispute to close.
    await handleRefunded(db, refunded(9n));

    expect(db.jobStatus(9n)).toBe("REFUNDED");
    expect(db.disputeRows()).toHaveLength(0);
  });
});

/**
 * In-memory stand-in for the store `handleMilestoneReleased` writes through, so
 * a partial-then-full payment sequence can be driven through the real handler
 * without a database (the same approach as `FakeDisputeStore`).
 */
class FakeMilestoneStore implements MilestoneReleaseStores {
  private readonly jobs = new Map<bigint, { id: string; asset: string; status: JobStatus }>();
  private readonly milestones = new Map<
    string,
    {
      id: string;
      jobId: string;
      index: number;
      status: MilestoneStatus;
      amount: string;
      releasedAmount: string;
      releasedAt: Date | null;
    }
  >();
  private seq = 0;

  /** Seed a job and its milestones; returns the job id. */
  seed(
    escrowId: bigint,
    specs: Array<{ amount: string; releasedAmount?: string; status?: MilestoneStatus }>,
    asset = "USDC",
  ): string {
    const id = `job-${++this.seq}`;
    this.jobs.set(escrowId, { id, asset, status: "ACTIVE" });
    specs.forEach((spec, index) => {
      this.milestones.set(`${id}:${index}`, {
        id: `ms-${id}-${index}`,
        jobId: id,
        index,
        status: spec.status ?? "PENDING",
        amount: spec.amount,
        releasedAmount: spec.releasedAmount ?? "0",
        releasedAt: null,
      });
    });
    return id;
  }

  jobStatus(escrowId: bigint): JobStatus | undefined {
    return this.jobs.get(escrowId)?.status;
  }

  milestoneRow(jobId: string, index: number) {
    const row = this.milestones.get(`${jobId}:${index}`);
    if (!row) throw new Error(`no milestone ${index} on ${jobId}`);
    return row;
  }

  job = {
    findUnique: async ({ where }: { where: { escrowId: bigint } }): Promise<MilestoneReleaseJob | null> => {
      const job = this.jobs.get(where.escrowId);
      if (!job) return null;
      return {
        id: job.id,
        asset: job.asset,
        milestones: [...this.milestones.values()]
          .filter((m) => m.jobId === job.id)
          .map((m) => ({
            id: m.id,
            index: m.index,
            status: m.status,
            amount: m.amount,
            releasedAmount: m.releasedAmount,
          })),
      };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { status: JobStatus };
    }) => {
      for (const job of this.jobs.values()) if (job.id === where.id) job.status = data.status;
      return {};
    },
  };

  // The handler's write surface (`MilestoneReleaseStores.milestone`).
  milestone = {
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { status?: MilestoneStatus; releasedAt?: Date; releasedAmount?: string };
    }) => {
      for (const row of this.milestones.values()) {
        if (row.id !== where.id) continue;
        if (data.status !== undefined) row.status = data.status;
        if (data.releasedAt !== undefined) row.releasedAt = data.releasedAt;
        if (data.releasedAmount !== undefined) row.releasedAmount = data.releasedAmount;
      }
      return {};
    },
  };
}

describe("milestone_released events (issue #25)", () => {
  const ESCROW = 7n;
  // 10 USDC at 7 decimals, in the i128 base units the event carries.
  const TEN = 100_000_000n;

  /** A real `milestone_released` payload, escrow_id included from topic1. */
  function released(index: number, amount: bigint): Record<string, unknown> {
    return eventFields(
      makeEvent(
        "milestone_released",
        { index: nativeToScVal(index, { type: "u32" }), amount: nativeToScVal(amount, { type: "i128" }) },
        10,
        [nativeToScVal(ESCROW, { type: "u64" })],
      ),
    );
  }

  it("does not mark a milestone RELEASED when only part of it has been paid", async () => {
    const db = new FakeMilestoneStore();
    const jobId = db.seed(ESCROW, [{ amount: "10" }]);

    await handleMilestoneReleased(released(0, 40_000_000n), db);

    // 4 of 10 USDC: the milestone is still open, so the job must stay ACTIVE.
    expect(db.milestoneRow(jobId, 0)).toMatchObject({
      status: "PENDING",
      releasedAmount: "4",
      releasedAt: null,
    });
    expect(db.jobStatus(ESCROW)).toBe("ACTIVE");
  });

  it("completes the milestone only once the partial payments add up", async () => {
    const db = new FakeMilestoneStore();
    const jobId = db.seed(ESCROW, [{ amount: "10" }]);

    await handleMilestoneReleased(released(0, 40_000_000n), db);
    expect(db.milestoneRow(jobId, 0).status).toBe("PENDING");

    // `release_milestone` emits only the remaining 6 USDC, not the 10 total —
    // comparing the event amount to the milestone total would still read this
    // as a partial and strand the job. The running total is what settles it.
    await handleMilestoneReleased(released(0, 60_000_000n), db);

    expect(db.milestoneRow(jobId, 0)).toMatchObject({ status: "RELEASED", releasedAmount: "10" });
    expect(db.milestoneRow(jobId, 0).releasedAt).toBeInstanceOf(Date);
    expect(db.jobStatus(ESCROW)).toBe("COMPLETED");
  });

  it("keeps the job ACTIVE while another milestone is still unpaid", async () => {
    const db = new FakeMilestoneStore();
    const jobId = db.seed(ESCROW, [{ amount: "10" }, { amount: "10" }]);

    await handleMilestoneReleased(released(0, TEN), db);

    expect(db.milestoneRow(jobId, 0).status).toBe("RELEASED");
    expect(db.milestoneRow(jobId, 1).status).toBe("PENDING");
    // One milestone fully paid is not the whole job.
    expect(db.jobStatus(ESCROW)).toBe("ACTIVE");
  });

  it("tolerates a milestone that was already part-paid before this event", async () => {
    // A cursor rewind replays events; the stored running total is the source of
    // truth, so the same event cannot release an already-known partial twice.
    const db = new FakeMilestoneStore();
    const jobId = db.seed(ESCROW, [{ amount: "10", releasedAmount: "6" }]);

    await handleMilestoneReleased(released(0, 40_000_000n), db);

    expect(db.milestoneRow(jobId, 0)).toMatchObject({ status: "RELEASED", releasedAmount: "10" });
    expect(db.jobStatus(ESCROW)).toBe("COMPLETED");
  });
});
