/**
 * indexer.ts
 *
 * Polls Soroban RPC for contract events emitted by the escrow, dispute, and
 * reputation contracts, then syncs state into PostgreSQL.
 *
 * This keeps the DB in sync without requiring the frontend to call /sync
 * endpoints manually after every transaction.
 *
 * The first poll does not start at ledger 1 — the RPC only retains a rolling
 * window of history, so a fresh cursor starts just behind the chain tip (see
 * `resolveStartLedger`).
 *
 * Events handled (see docs/EVENTS.md):
 *   escrow     — created, funded, milestones_updated, milestone_released,
 *                dispute_opened, resolved, refunded,
 *                dispute_contract_updated (recognized; no job state to update)
 *   dispute    — raised, approved, dispute_resolved
 *   reputation — rated
 *
 * Almost every event carries its `escrow_id` in `topic[1]` rather than in the
 * data map; `decodeEventFields` merges the two so a handler always sees it (see
 * the doc comment on its `EVENT_TOPIC_FIELDS`).
 *
 * Dispute record semantics (see docs/DISPUTES.md):
 *   - `dispute_opened` only marks the job DISPUTED. There is no Dispute row yet:
 *     the on-chain dispute has no id or reason until `dispute.raise`, so the row
 *     is created when `raised` is indexed. A job is therefore DISPUTED with an
 *     empty `disputes[]` between the two transactions — by design.
 *   - `refunded` is terminal, so it also closes any open dispute for the escrow
 *     (RAISED/UNDER_REVIEW → REFUNDED). Without that, a refunded job would keep
 *     reporting a live dispute forever, because no later event touches it.
 *   - `resolved` sets both the job (COMPLETED) and its dispute (RESOLVED);
 *     `REFUNDED` and `RESOLVED` are the two terminal dispute states.
 *
 * Contributor Notes:
 * - Every recognised event is also stored verbatim in ChainEvent (issue #72) so
 *   a per-user history and an escrow receipt can link to the transaction that
 *   emitted it; the state handlers below are unaffected by that write, which is
 *   best-effort.
 * - The cursor (last scanned ledger) is persisted in IndexerCursor, so the
 *   indexer resumes after a restart and does not reprocess applied ledgers.
 * - Unknown events are ignored; a failed event is logged and recorded in
 *   IndexerDeadLetter so it cannot block the rest of the batch *or* vanish.
 *   Because the cursor still advances, a dead letter is a permanent record of
 *   state that is missing from the DB — query it after the fact:
 *     SELECT * FROM "IndexerDeadLetter" ORDER BY "lastSeenAt" DESC;
 *   Re-run the affected event by hand once the bug is fixed, then delete the row.
 */

import type { PrismaClient } from "@prisma/client";
import { SorobanRpc, xdr } from "@stellar/stellar-sdk";
import type { DisputeStatus, JobStatus, MilestoneStatus, NotificationType } from "@prisma/client";
import { config } from "./config";
import { prisma } from "./db";
import { checkConfiguredContractIds, type ContractIdName } from "./lib/contractFreshness";
import { ASSETS, formatAmount, fromBaseUnits, toBaseUnits } from "./lib/assets";
import { FUNDED_JOB_STATUS } from "./lib/jobStatus";
import {
  KNOWN_EVENTS,
  decodeEventFields,
  decodeEventName,
  eventEscrowId,
  type ContractEventLike,
} from "./lib/events";
import {
  notifyDisputeOpened,
  notifyMilestoneReleased,
  notifyEscrowRefunded,
} from "./lib/notifications";

const CURSOR_ID = "main";
export const EVENT_PAGE_LIMIT = 100;

/** Longest error message persisted to IndexerDeadLetter.error. */
const MAX_ERROR_LENGTH = 500;

/**
 * Soroban RPC only serves a rolling window of ledgers (~7 days; the testnet RPC
 * reports roughly 120,960), so `startLedger` outside it is rejected outright
 * with `startLedger must be within the ledger range`. Two cases have to be kept
 * inside the window: a fresh cursor of 0, and a cursor older than the window
 * (the indexer was down for longer than the RPC retains history).
 */
const RPC_LEDGER_WINDOW = 120_960;

/**
 * Where a fresh indexer starts. It cannot backfill from genesis, so it begins
 * just behind the chain tip and picks up events emitted before its first boot.
 */
const FIRST_RUN_LOOKBACK_LEDGERS = 100;

const CONTRACT_IDS = [
  config.ESCROW_CONTRACT_ID,
  config.DISPUTE_CONTRACT_ID,
  config.REPUTATION_CONTRACT_ID,
].filter(Boolean);

/** The contracts the indexer is expected to follow, for a partial-config check. */
const INDEXED_CONTRACTS: ContractIdName[] = ["escrow", "dispute", "reputation"];

const rpcServer = new SorobanRpc.Server(config.SOROBAN_RPC_URL, { allowHttp: false });

/** Minimal surface of `SorobanRpc.Server` the indexer needs (for testing). */
export interface SorobanEventSource {
  getEvents(request: {
    startLedger?: number;
    filters: SorobanRpc.Api.EventFilter[];
    limit?: number;
    cursor?: string;
  }): Promise<{ events: ContractEventLike[]; latestLedger: number }>;
  /**
   * Chain tip, used to keep `startLedger` inside the RPC's retention window.
   * Optional so tests and other callers can supply just `getEvents`.
   */
  getLatestLedger?(): Promise<number>;
}

/** Persisted indexer cursor. */
export interface CursorStore {
  get(): Promise<number>;
  set(ledger: number): Promise<void>;
}

/**
 * The slice of Prisma the event handlers write through.
 *
 * Handlers receive this instead of closing over the module-level client, so a
 * test can drive a whole event sequence against an in-memory fake and assert the
 * resulting job / milestone / dispute rows without a database.
 */
export interface IndexerStore {
  job: Pick<PrismaClient["job"], "findUnique" | "update" | "updateMany">;
  milestone: Pick<PrismaClient["milestone"], "update" | "updateMany">;
  dispute: Pick<PrismaClient["dispute"], "updateMany" | "upsert">;
  /** Rating slice, shaped like `RatedStores` so `applyRatedEvent` accepts it. */
  user: RatedStores["user"];
  rating: RatedStores["rating"];
  chainEvent?: Pick<PrismaClient["chainEvent"], "upsert">;
}

export function startIndexer() {
  // Contract ids change on every deploy, so compare the configured ones with
  // the last deploy record before doing anything else. Stale-but-non-empty ids
  // used to leave the indexer polling the superseded contracts with no warning
  // at all; this turns that silent misconfiguration into a loud log line.
  checkConfiguredContractIds({
    escrow: config.ESCROW_CONTRACT_ID,
    dispute: config.DISPUTE_CONTRACT_ID,
    reputation: config.REPUTATION_CONTRACT_ID,
  });

  if (CONTRACT_IDS.length === 0) {
    console.warn("[indexer] No contract IDs configured — skipping.");
    return { stop: async () => {} };
  }

  if (CONTRACT_IDS.length < INDEXED_CONTRACTS.length) {
    console.warn(
      `[indexer] Only ${CONTRACT_IDS.length}/${INDEXED_CONTRACTS.length} contract IDs ` +
        "configured — events from the unconfigured contract(s) will not be indexed.",
    );
  }

  console.log("[indexer] Starting, polling every", config.INDEXER_POLL_INTERVAL_MS, "ms");

  let stopped = false;
  // The poll currently running, if any; `stop()` awaits it.
  let inFlight: Promise<void> | null = null;

  const tick = () => {
    // `poll()` catches its own errors, so this only guards against overlap:
    // one poll at a time keeps two writers off the same cursor row.
    if (stopped || inFlight) return;
    inFlight = poll().finally(() => {
      inFlight = null;
    });
  };

  tick();
  const timer = setInterval(tick, config.INDEXER_POLL_INTERVAL_MS);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

async function poll() {
  try {
    const row = await prisma.indexerCursor.upsert({
      where: { id: CURSOR_ID },
      create: { id: CURSOR_ID, lastLedger: 0 },
      update: {},
    });

    const cursor: CursorStore = {
      get: async () => row.lastLedger,
      set: async (ledger) => {
        await prisma.indexerCursor.update({
          where: { id: CURSOR_ID },
          data: { lastLedger: ledger },
        });
      },
    };

    const source: SorobanEventSource = {
      getEvents: (request) => rpcServer.getEvents(request),
      getLatestLedger: async () => (await rpcServer.getLatestLedger()).sequence,
    };

    await processContractEvents(source, cursor, CONTRACT_IDS);
  } catch (err) {
    console.error("[indexer] Poll error:", err);
  }
}

/**
 * Pick the ledger to scan from.
 *
 * A cursor of 0 means "never run": starting at ledger 1 makes the RPC reject
 * every poll because the ledger is older than it retains, which is exactly the
 * failure that leaves a fresh deployment with an indexer that logs forever and
 * never syncs.
 */
export async function resolveStartLedger(
  source: SorobanEventSource,
  cursorLedger: number,
): Promise<number> {
  const latest = await chainTip(source);
  if (latest === null) return cursorLedger + 1; // no tip available; trust the cursor

  if (cursorLedger === 0) {
    return Math.max(1, latest - FIRST_RUN_LOOKBACK_LEDGERS);
  }

  const earliest = latest - RPC_LEDGER_WINDOW + 1;
  const start = cursorLedger + 1;
  if (start < earliest) {
    console.warn(
      `[indexer] cursor at ledger ${cursorLedger} is older than the RPC window; ` +
        `skipping to ${earliest}. Events between the two are no longer retrievable.`,
    );
    return earliest;
  }
  return start;
}

/** Chain tip, or null when the source cannot report one or the call fails. */
async function chainTip(source: SorobanEventSource): Promise<number | null> {
  if (!source.getLatestLedger) return null;
  try {
    return await source.getLatestLedger();
  } catch (err) {
    // Falling back to the cursor beats skipping a poll entirely.
    console.error("[indexer] could not read the chain tip", err);
    return null;
  }
}

/**
 * Fetch and process events for the given contracts, then advance the cursor.
 *
 * `dispatch` and `onError` are injectable so the cursor/decoding/dead-letter
 * logic is testable without a chain or database.
 */
export async function processContractEvents(
  source: SorobanEventSource,
  cursor: CursorStore,
  contractIds: string[],
  dispatch: (event: ContractEventLike) => Promise<void> = dispatchEvent,
  onError: (event: ContractEventLike, error: unknown) => Promise<void> = recordDeadLetter,
): Promise<number> {
  const lastLedger = await cursor.get();
  if (contractIds.length === 0) return lastLedger;

  const filters = contractIds.map((contractId) => ({
    type: "contract" as const,
    contractIds: [contractId],
  }));

  let currentStartLedger: number | undefined = await resolveStartLedger(source, lastLedger);
  let currentCursor: string | undefined = undefined;
  let maxLatestLedger = lastLedger;

  while (true) {
    const res = await source.getEvents({
      ...(currentCursor ? { cursor: currentCursor } : { startLedger: currentStartLedger }),
      filters,
      limit: EVENT_PAGE_LIMIT,
    });

    maxLatestLedger = Math.max(maxLatestLedger, res.latestLedger);

    for (const event of res.events) {
      try {
        await dispatch(event);
      } catch (err) {
        // One bad event must not block the rest of the batch.
        console.error(`[indexer] failed to process event ${event.id ?? "?"}`, err);
        // Recording the failure must never take the poller down with it.
        try {
          await onError(event, err);
        } catch (storeErr) {
          console.error("[indexer] could not record the failed event", storeErr);
        }
      }
    }

    if (res.events.length < EVENT_PAGE_LIMIT) {
      break;
    }

    const lastEvent = res.events[res.events.length - 1];
    if (lastEvent?.id) {
      if (lastEvent.id === currentCursor) {
        // Cursor did not advance, break to avoid an infinite loop
        break;
      }
      currentCursor = lastEvent.id;
      currentStartLedger = undefined;
    } else if (lastEvent?.ledger) {
      const nextLedger = lastEvent.ledger + 1;
      if (currentStartLedger !== undefined && nextLedger <= currentStartLedger) {
        break;
      }
      currentStartLedger = nextLedger;
      currentCursor = undefined;
    } else {
      break;
    }
  }

  // Advance only after every event across all pages has been attempted.
  const next = Math.max(lastLedger, maxLatestLedger);
  await cursor.set(next);
  return next;
}

// ---------------------------------------------------------------------------
// Dead letters
// ---------------------------------------------------------------------------

/** Stable key for an event: RPC ids are stable, so a rewind re-uses the row. */
function deadLetterKey(event: ContractEventLike): string {
  return event.id ?? `ledger-${event.ledger}-${decodeEventName(event) ?? "unknown"}`;
}

/**
 * Persist an event the indexer could not apply. The cursor still advances, so
 * this row is the only trace that a state change was skipped.
 */
export async function recordDeadLetter(
  event: ContractEventLike,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
  const id = deadLetterKey(event);
  const eventPayload = serializeDeadLetterEvent(event);

  await prisma.indexerDeadLetter.upsert({
    where: { id },
    create: {
      id,
      ledger: event.ledger,
      eventName: decodeEventName(event),
      contractId: (event as { contractId?: string }).contractId ?? null,
      error: message,
      eventPayload,
    },
    update: {
      attempts: { increment: 1 },
      error: message,
      eventPayload,
    },
  });
}

export function serializeDeadLetterEvent(event: ContractEventLike) {
  return {
    ledger: event.ledger,
    topic: event.topic.map((value) => value.toXDR("base64")),
    value: event.value.toXDR("base64"),
    ...(event.id ? { id: event.id } : {}),
    ...(event.txHash ? { txHash: event.txHash } : {}),
    ...(event.ledgerClosedAt ? { ledgerClosedAt: event.ledgerClosedAt } : {}),
  };
}

/** Restore the raw event persisted alongside a dead-letter row. */
export function restoreDeadLetterEvent(payload: unknown): ContractEventLike {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Dead letter has no replayable event payload");
  }
  const row = payload as Record<string, unknown>;
  if (
    !Number.isInteger(row.ledger) ||
    !Array.isArray(row.topic) ||
    !row.topic.every((value) => typeof value === "string") ||
    typeof row.value !== "string"
  ) {
    throw new Error("Dead letter event payload is invalid");
  }

  return {
    ledger: row.ledger as number,
    topic: row.topic.map((value) => xdr.ScVal.fromXDR(value, "base64")),
    value: xdr.ScVal.fromXDR(row.value, "base64"),
    ...(typeof row.id === "string" ? { id: row.id } : {}),
    ...(typeof row.txHash === "string" ? { txHash: row.txHash } : {}),
    ...(typeof row.ledgerClosedAt === "string" ? { ledgerClosedAt: row.ledgerClosedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Dispatch + handlers
// ---------------------------------------------------------------------------

/**
 * Each event's `#[topic]` data fields, in `topic[1..]` order (docs/EVENTS.md).
 *
 * `created` and `funded` are deliberately absent: their topic is the client
 * address and their `escrow_id` is an ordinary data field. Every other event
 * carries `escrow_id` (or, for `approved`, `dispute_id`) in `topic[1]`, so
 * decoding only the value map left those handlers with no id to look the row up
 * by — `handleDisputeOpened`, `handleRaised`, `handleRefunded`,
 * `handleMilestoneReleased`, `handleResolved` and `handleRated` all returned
 * without doing anything, so the mirror silently stopped tracking the chain
 * after funding.
 */
export const EVENT_TOPIC_FIELDS: Record<string, string[]> = {
  milestone_released: ["escrow_id"],
  milestones_updated: ["escrow_id"],
  dispute_opened: ["escrow_id"],
  resolved: ["escrow_id"],
  refunded: ["escrow_id"],
  raised: ["escrow_id"],
  dispute_resolved: ["escrow_id"],
  approved: ["dispute_id"],
  rated: ["escrow_id"],
};

/**
 * Apply one decoded event to the database. Exported so tests can drive a
 * sequence of events through the real handlers against a fake store.
 */
export async function dispatchEvent(
  event: ContractEventLike,
  store: IndexerStore = prisma,
): Promise<void> {
  const name = decodeEventName(event);
  if (!name || !KNOWN_EVENTS.has(name)) return; // unknown events are ignored

  const data = decodeEventFields(event, EVENT_TOPIC_FIELDS[name] ?? []);
  // The id lives in the data map for `created`/`funded` and in the `#[topic]`
  // field for every other event (see lib/events.ts).
  const escrowId = eventEscrowId(event);
  if (escrowId !== null && data.escrow_id === undefined) {
    data.escrow_id = escrowId;
  }

  // Record the event itself (issue #72). Best-effort: history is derived data,
  // and a failure to store it must not stop the state mirror below from being
  // updated — a dropped history row is recoverable by replaying the event,
  // whereas a skipped state change is what the dead-letter table exists for.
  try {
    const row = buildChainEvent(event, name, data);
    if (row && store.chainEvent?.upsert) {
      await store.chainEvent.upsert({ where: { id: row.id }, create: row, update: {} });
    }
  } catch (err) {
    console.error(`[indexer] could not record event ${event.id ?? "?"} in the history`, err);
  }

  switch (name) {
    case "created":
      await handleCreated(escrowId, store);
      break;
    case "funded":
      await handleFunded(escrowId, store);
      break;
    case "milestones_updated":
      await handleMilestonesUpdated(escrowId, data, store);
      break;
    case "milestone_released":
      await handleMilestoneReleased(data, store as unknown as MilestoneReleaseStores);
      break;
    case "dispute_opened":
      await handleDisputeOpened(store as unknown as DisputeLifecycleStores, data);
      break;
    case "resolved":
    case "dispute_resolved":
      await handleResolved(escrowId, store);
      break;
    case "refunded":
      await handleRefunded(store as unknown as DisputeLifecycleStores, data);
      break;
    case "raised":
      await handleRaised(store as unknown as DisputeLifecycleStores, data);
      break;
    case "rated":
      await handleRated(escrowId, data, store);
      break;
    default:
      // milestones_updated / approved / dispute_contract_updated do not
      // change indexed job state — dispute_contract_updated is an admin
      // contract-config rotation (audited on-chain via getEvents), and no
      // Job row is affected by it.
      break;
  }
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

function asNumber(value: unknown): number | null {
  const big = asBigInt(value);
  return big === null ? null : Number(big);
}

function asAddress(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Transaction history (issue #72)
// ---------------------------------------------------------------------------

/**
 * The fields an event moves value in, summed when an event splits funds.
 *
 * Deliberately narrow: `created` and `milestones_updated` report a total (the
 * escrow's), not a movement, so they carry no amount and a history row for them
 * shows none rather than a misleading figure.
 */
const EVENT_AMOUNT_FIELDS: Record<string, string[]> = {
  funded: ["amount"],
  milestone_released: ["amount"],
  refunded: ["amount"],
  // The two shares are what the ruling actually distributed.
  resolved: ["client_share", "freelancer_share"],
};

/** A new `ChainEvent` row: how an indexed event is stored for a history view. */
export interface ChainEventRow {
  id: string;
  escrowId: bigint;
  action: string;
  /** In the asset's integer base units, or `null` when the event moves nothing. */
  amount: string | null;
  txHash: string | null;
  ledger: number;
  createdAt: Date;
}

/** The value an event moved, in base units, or `null` if it moved none. */
function eventAmount(name: string, data: Record<string, unknown>): string | null {
  const fields = EVENT_AMOUNT_FIELDS[name];
  if (!fields) return null;
  const values = fields
    .map((field) => asBigInt(data[field]))
    .filter((value): value is bigint => value !== null);
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0n).toString();
}

/**
 * Turn an event into the row a history view reads, or `null` when it cannot be
 * one: an event is only history if it belongs to an escrow (`approved` carries no
 * escrow id) and has a value we would store.
 *
 * Pure, so the amount extraction and the fallbacks are unit-testable without a
 * database (see `__tests__/indexer.test.ts`).
 */
export function buildChainEvent(
  event: ContractEventLike,
  name: string,
  data: Record<string, unknown>,
): ChainEventRow | null {
  const escrowId = asBigInt(data.escrow_id);
  if (escrowId === null) return null;

  // RPC ids are stable, so a replayed event upserts the same row; the composed
  // key is only for fixtures that carry no id.
  const id = event.id ?? `${event.ledger}-${name}-${escrowId}`;

  const closedAt = event.ledgerClosedAt ? new Date(event.ledgerClosedAt) : null;
  const createdAt =
    closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : new Date();

  return {
    id,
    escrowId,
    action: name,
    amount: eventAmount(name, data),
    txHash: event.txHash ?? null,
    ledger: event.ledger,
    createdAt,
  };
}

async function notifyParticipants(
  escrowId: bigint,
  type: NotificationType,
  title: string,
  message: string,
  jobStore?: { findUnique(args: { where: { escrowId: bigint } }): Promise<unknown> },
): Promise<void> {
  try {
    if (config.NODE_ENV === "test" || (jobStore && jobStore !== (prisma.job as unknown))) {
      return;
    }
    const finder = jobStore ?? prisma.job;
    const rawJob = await finder.findUnique({
      where: { escrowId },
    });
    if (!rawJob || typeof rawJob !== "object") return;
    const job = rawJob as { id: string; clientId?: string; freelancerId?: string | null };
    const recipients = [job.clientId, job.freelancerId].filter((id): id is string => Boolean(id));
    if (recipients.length === 0) return;
    await Promise.all(
      recipients.map((userId) =>
        prisma.notification?.create({
          data: {
            userId,
            jobId: job.id,
            type,
            title,
            message,
          },
        }),
      ),
    );
  } catch {
    // Gracefully ignore notification failure if database is unavailable or mocked
  }
}

export async function handleCreated(escrowId: bigint | null, store: IndexerStore): Promise<void> {
  if (escrowId === null) return;
  const result = await store.job.updateMany({ where: { escrowId }, data: { status: "CREATED" } });
  if (result.count === 0) {
    throw new Error(`unlinked escrow: no job found for escrow id ${escrowId}`);
  }
}

export async function handleFunded(escrowId: bigint | null, store: IndexerStore): Promise<void> {
  if (escrowId === null) return;
  const result = await store.job.updateMany({
    where: { escrowId },
    // Shared with POST /api/escrow/sync/:jobId so the two writers of the funded
    // transition cannot disagree again (issue #43).
    data: { status: FUNDED_JOB_STATUS },
  });
  if (result.count === 0) {
    throw new Error(`unlinked escrow: no job found for escrow id ${escrowId}`);
  }
  await notifyParticipants(escrowId, "FUNDED", "Escrow Funded", "Escrow has been funded.", store.job);
}

/**
 * `update_milestones` replaces the whole breakdown and emits only `count` and
 * `total_amount`. The event can reconcile an unchanged breakdown, but cannot
 * rebuild an edited one; mark mismatched rows stale until the client records
 * the confirmed breakdown through `PUT /api/escrow/:escrowId/milestones`.
 */
async function handleMilestonesUpdated(
  escrowId: bigint | null,
  data: Record<string, unknown>,
  store: IndexerStore,
): Promise<void> {
  const totalAmount = asBigInt(data.total_amount);
  const count = asNumber(data.count);
  if (escrowId === null || totalAmount === null || totalAmount <= 0n || count === null || count < 0) {
    return;
  }

  const job = await store.job.findUnique({ where: { escrowId }, include: { milestones: true } });
  if (!job) return;

  const decimals = ASSETS[String(job.asset).toUpperCase()]?.decimals ?? 7;
  const currentMilestoneTotal = job.milestones.reduce(
    (sum, milestone) => sum + toBaseUnits(milestone.amount.toString(), decimals),
    0n,
  );
  if (job.milestones.length !== count || currentMilestoneTotal !== totalAmount) {
    await store.milestone.updateMany({
      where: { jobId: job.id },
      data: { isStale: true },
    });
  }
  await store.job.update({
    where: { id: job.id },
    data: { totalAmount: fromBaseUnits(totalAmount, decimals) },
  });
}

/**
 * The slice of `prisma` the milestone-release handler reads and writes, kept
 * structural (like `DisputeLifecycleStores`) so a partial-then-full sequence can
 * be driven through the real handler against an in-memory store.
 */
export interface MilestoneReleaseStores {
  job: {
    findUnique(args: {
      where: { escrowId: bigint };
      include: { milestones: true };
    }): Promise<MilestoneReleaseJob | null>;
    update(args: { where: { id: string }; data: { status: JobStatus } }): Promise<unknown>;
  };
  milestone: {
    update(args: {
      where: { id: string };
      data: {
        status?: MilestoneStatus;
        releasedAt?: Date;
        releasedAmount?: string;
      };
    }): Promise<unknown>;
  };
}

/** The job row `handleMilestoneReleased` loads, milestones included. */
export interface MilestoneReleaseJob {
  id: string;
  /** Asset symbol the job pays in — selects the decimal scale for the amounts. */
  asset: string;
  milestones: Array<{
    id: string;
    index: number;
    status: MilestoneStatus;
    /** Prisma `Decimal` at runtime; anything stringifiable works here. */
    amount: { toString(): string } | string | number;
    releasedAmount: { toString(): string } | string | number;
  }>;
}

/**
 * A `milestone_released` event is emitted by *both* `release_milestone` and
 * `release_partial`, and its `amount` is the sum paid by *this* call — not the
 * milestone's total. Marking the milestone RELEASED on every event (the
 * behaviour before issue #25) records a half-paid milestone as done and
 * completes the job while the freelancer is still owed the remainder.
 *
 * So the handler accumulates: each event's `amount` is added to the milestone's
 * `releasedAmount`, and the milestone only flips to RELEASED once the running
 * total reaches `amount`. Comparing the event's amount to the milestone
 * total instead would still be wrong for a partial-then-full sequence, because
 * `release_milestone` emits only the *remaining* amount after earlier partials.
 * The job completes only when every milestone is fully released.
 */
export async function handleMilestoneReleased(
  data: Record<string, unknown>,
  store: MilestoneReleaseStores = prisma as unknown as MilestoneReleaseStores,
): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  const index = asNumber(data.index);
  if (escrowId === null || index === null) return;

  const job = await store.job.findUnique({
    where: { escrowId },
    include: { milestones: true },
  });
  if (!job) return;

  const milestone = job.milestones.find((m) => m.index === index);
  if (!milestone) return;

  // Amounts arrive as i128 base units; the milestone columns are decimals in
  // the asset's human units. Convert both to base units (exact bigint math),
  // then store the human-unit string back.
  const decimals = ASSETS[job.asset.toUpperCase()]?.decimals ?? 7;
  const milestoneTotal = toBaseUnits(String(milestone.amount), decimals);
  const releasedSoFar =
    toBaseUnits(String(milestone.releasedAmount ?? 0), decimals) + (asBigInt(data.amount) ?? 0n);

  // A zero-amount milestone cannot be "released" by arithmetic; leave it alone.
  const fullyReleased = milestoneTotal > 0n && releasedSoFar >= milestoneTotal;

  await store.milestone.update({
    where: { id: milestone.id },
    data: fullyReleased
      ? {
          status: "RELEASED",
          releasedAt: new Date(),
          // Clamp: the chain never over-releases, but a stray event must not
          // push the stored total past the milestone.
          releasedAmount: formatAmount(milestoneTotal, decimals),
        }
      : { releasedAmount: formatAmount(releasedSoFar, decimals) },
  });

  if (!fullyReleased) return;

  const allReleased = job.milestones.every(
    (m) => m.id === milestone.id || m.status === "RELEASED",
  );
  if (allReleased) {
    await store.job.update({ where: { id: job.id }, data: { status: "COMPLETED" } });
  }
}

// ---------------------------------------------------------------------------
// Dispute lifecycle
// ---------------------------------------------------------------------------

/**
 * The slice of `prisma` the dispute-lifecycle handlers touch, kept structural so
 * the event sequence is unit-testable with an in-memory store instead of a
 * database (the same approach as `RatedStores`).
 */
export interface DisputeLifecycleStores {
  job: {
    findUnique(args: {
      where: { escrowId: bigint };
      include?: unknown;
    }): Promise<{ id: string; title?: string; client?: any; freelancer?: any } | null>;
    updateMany(args: {
      where: { escrowId: bigint };
      data: { status: JobStatus };
    }): Promise<unknown>;
  };
  dispute: {
    upsert(args: {
      where: { jobId: string };
      create: {
        onChainId: bigint;
        jobId: string;
        raisedByAddress: string;
        reason: string;
        status?: DisputeStatus;
      };
      update: {
        onChainId: bigint;
        raisedByAddress: string;
        status?: DisputeStatus;
      };
    }): Promise<unknown>;
    updateMany(args: {
      where: { job: { escrowId: bigint }; status: { in: DisputeStatus[] } };
      data: { status: DisputeStatus; resolvedAt: Date };
    }): Promise<unknown>;
  };
}


/** Dispute statuses that are still open — exactly the ones a refund has to close. */
const OPEN_DISPUTE_STATUSES: DisputeStatus[] = ["RAISED", "UNDER_REVIEW"];

/**
 * `dispute_opened` (escrow.open_dispute) only marks the job DISPUTED.
 *
 * It deliberately creates no Dispute row: the on-chain dispute has no id or
 * reason until `dispute.raise`, so there is nothing to record yet. The row is
 * created when `raised` is indexed below, which is why a job can be DISPUTED
 * with an empty `disputes[]` between the two transactions (docs/DISPUTES.md).
 */
export async function handleDisputeOpened(
  db: DisputeLifecycleStores,
  data: Record<string, unknown>,
): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  if (escrowId === null) return;
  await db.job.updateMany({ where: { escrowId }, data: { status: "DISPUTED" } });
  await notifyParticipants(
    escrowId,
    "DISPUTED",
    "Dispute Opened",
    "A dispute has been opened for the job.",
    db.job,
  );
}

/**
 * `escrow.resolve` pays out every milestone and marks the escrow Completed in
 * one transaction, publishing only `resolved`. There are no per-milestone
 * `milestone_released` events for that payout, so the milestones have to be
 * settled here: otherwise an arbitrated job is COMPLETED while all of its
 * milestones stay PENDING with `releasedAt: null` forever, and every
 * milestone-derived view (progress, unreleased amount, earnings) is wrong for
 * the one case where the database is furthest from the chain.
 *
 * The contract sets each milestone's `released_amount` to its full `amount`
 * before it distributes the shares (`escrow/src/lib.rs` → `resolve`), so the
 * mirror has to write `releasedAmount` too. Flipping only `status`/`releasedAt`
 * left it at its `0` default: a resolved job was COMPLETED with milestones that
 * were RELEASED but appeared to have paid out nothing, so every aggregate built
 * on `releasedAmount` (earnings, payment history, audit totals) under-counted
 * those escrows. `handleMilestoneReleased` already stamps the full total, and a
 * resolution is the same terminal release for every milestone.
 *
 * The milestones are updated one row at a time because `releasedAmount` is the
 * row's own `amount` (converted through the asset's decimals), which an
 * `updateMany` cannot express. `releasedAt` is the same instant for the job, the
 * dispute and the milestones, because the contract changes them all in a single
 * transaction.
 */
async function handleResolved(
  escrowId: bigint | null,
  store: IndexerStore,
): Promise<void> {
  if (escrowId === null) return;

  const resolvedAt = new Date();
  await store.job.updateMany({ where: { escrowId }, data: { status: "COMPLETED" } });
  await store.dispute.updateMany({
    where: { job: { escrowId } },
    data: { status: "RESOLVED", resolvedAt },
  });

  const job = await store.job.findUnique({
    where: { escrowId },
    include: { milestones: true },
  });
  if (job) {
    const decimals = ASSETS[job.asset.toUpperCase()]?.decimals ?? 7;
    for (const milestone of job.milestones) {
      // The chain stores base units; the column is a decimal in the asset's
      // human units. Reuse the same exact conversion as the release handler so
      // both paths write `releasedAmount` in one format.
      const amount = toBaseUnits(String(milestone.amount), decimals);
      await store.milestone.update({
        where: { id: milestone.id },
        data: {
          status: "RELEASED",
          releasedAt: resolvedAt,
          releasedAmount: formatAmount(amount, decimals),
        },
      });
    }
  }

  await notifyParticipants(
    escrowId,
    "RESOLVED",
    "Dispute Resolved",
    "The dispute has been resolved.",
    store.job,
  );
}

/**
 * `refunded` is emitted by both `reclaim_expired` (Active → Refunded) and
 * `reclaim_after_dispute_timeout` (Disputed → Refunded).
 *
 * The escrow is now terminal, so no later event will ever close the dispute it
 * was tied to. Left alone, the row keeps status RAISED/UNDER_REVIEW with
 * `resolvedAt` null forever and every "open disputes" view reports a job whose
 * funds already went back to the client. So the refund also closes the open
 * disputes for that escrow: status REFUNDED (not RESOLVED, which means a panel
 * ruled) with `resolvedAt` stamped. `reclaim_expired` runs from Active and so
 * matches no dispute — that is expected.
 */
export async function handleRefunded(
  db: DisputeLifecycleStores,
  data: Record<string, unknown>,
): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  if (escrowId === null) return;

  await db.job.updateMany({ where: { escrowId }, data: { status: "REFUNDED" } });

  await db.dispute.updateMany({
    where: { job: { escrowId }, status: { in: OPEN_DISPUTE_STATUSES } },
    data: { status: "REFUNDED", resolvedAt: new Date() },
  });

  try {
    const job = await db.job.findUnique({
      where: { escrowId },
      include: { client: true, freelancer: true },
    });
    if (job && job.title) await notifyEscrowRefunded(job as any);
  } catch (notifyErr) {
    console.error("[notifications] Failed to send refund notification:", notifyErr);
  }
}

/**
 * `raised` (dispute.raise) attaches the on-chain dispute id to the job's
 * dispute, creating the row if the API never recorded one.
 *
 * Upserted on `jobId`, not on `onChainId`: `POST /api/disputes` writes the row
 * (with the reason) before the contract has minted an id, so a row already
 * exists for the job and its `onChainId` is still null. Keying on `onChainId`
 * alone — as this handler used to — matches nothing and inserts a second row,
 * leaving the job with one dispute holding the reason and another holding the
 * id. One row per job is also a database constraint now (`Dispute.jobId` is
 * unique), which is the same invariant `dispute.raise` enforces on-chain
 * (`AlreadyRaised` for a second raise on the same escrow).
 *
 * The event wins for the two fields it carries: `raised_by` is the address the
 * contract validated as a party, while the row's `raisedByAddress` is merely
 * whoever called `POST /api/disputes`, and the two differ when one party records
 * the dispute and the other raises it. `reason` is not in the event, so the
 * stored one is left untouched — it is the only copy.
 *
 * Idempotent: re-running it for the same event re-writes the same values, so a
 * cursor rewind cannot duplicate or corrupt the row.
 */
export async function handleRaised(
  db: DisputeLifecycleStores,
  data: Record<string, unknown>,
): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  const disputeId = asBigInt(data.dispute_id);
  if (escrowId === null || disputeId === null) return;

  const job = await db.job.findUnique({ where: { escrowId } });
  if (!job) return;

  await db.dispute.upsert({
    where: { jobId: job.id },      create: {
        onChainId: disputeId,
        jobId: job.id,
        raisedByAddress: String(data.raised_by ?? ""),
        reason: "",
        // `raised` is the confirmation; a row created here is real, not PENDING.
        status: "RAISED",
      },
      update: {
        onChainId: disputeId,
        raisedByAddress: String(data.raised_by ?? ""),
        status: "RAISED",
      },
  });
}

// ---------------------------------------------------------------------------
// Rated events
// ---------------------------------------------------------------------------

/**
 * The slice of `prisma` `applyRatedEvent` touches, kept structural so the
 * handler is unit-testable with an in-memory store instead of a database
 * (the same approach as `AuthNonceStore` in lib/authNonce.ts).
 */
export interface RatedStores {
  job: {
    findUnique(args: { where: { escrowId: bigint } }): Promise<{ id: string } | null>;
  };
  user: {
    upsert(args: {
      where: { stellarAddress: string };
      create: { stellarAddress: string };
      update: Record<string, never>;
    }): Promise<{ id: string }>;
  };
  rating: {
    upsert(args: {
      where: { raterId_jobId: { raterId: string; jobId: string } };
      create: { jobId: string; raterId: string; rateeId: string; score: number };
      update: { rateeId: string; score: number };
    }): Promise<unknown>;
  };
}

/** A decoded `rated` event, or `null` when a field is missing/malformed. */
interface RatedEvent {
  escrowId: bigint;
  rater: string;
  ratee: string;
  score: number;
}

function parseRatedEvent(escrowId: bigint, data: Record<string, unknown>): RatedEvent | null {
  const rater = asAddress(data.rater);
  const ratee = asAddress(data.ratee);
  const score = asNumber(data.score);
  if (escrowId === null || rater === null || ratee === null || score === null) return null;
  return { escrowId, rater, ratee, score };
}

/** What `applyRatedEvent` did, so callers (and tests) can tell them apart. */
export type RatedOutcome =
  | { status: "applied"; jobId: string; score: number }
  | { status: "skipped"; reason: "malformed" | "unknown-job" };

/**
 * Persist a `rated` event as a single Rating row.
 *
 * `reputation.submit` is the only way a rating is created, and a client can
 * bypass this API entirely (`stellar contract invoke`, `scripts/demo_testnet.sh`),
 * so for those ratings the event is the only record we get. The row is keyed by
 * `(rater, job)` — the same key `POST /api/reputation` uses — so a row that the
 * API wrote before the transaction landed is updated in place rather than
 * duplicated, and the on-chain score (authoritative) overwrites the placeholder
 * while the off-chain `comment` is preserved.
 *
 * A rating event whose escrow has no off-chain Job row is skipped: `Rating.jobId`
 * is required, and inventing a job from a rating would put fabricated data in
 * the listing. The event is logged so it can be reconciled by hand.
 *
 * `escrowId` is the event's `#[topic]` field, which is why it is passed in
 * rather than read from the data map — see `eventEscrowId` in lib/events.ts.
 */
export async function applyRatedEvent(
  db: RatedStores,
  escrowId: bigint,
  data: Record<string, unknown>,
): Promise<RatedOutcome> {
  const event = parseRatedEvent(escrowId, data);
  if (!event) return { status: "skipped", reason: "malformed" };

  const job = await db.job.findUnique({ where: { escrowId: event.escrowId } });
  if (!job) return { status: "skipped", reason: "unknown-job" };

  // An on-chain rater/ratee may never have authenticated against this API, so
  // materialise the user rows rather than dropping the rating on the floor.
  const [rater, ratee] = await Promise.all([
    db.user.upsert({
      where: { stellarAddress: event.rater },
      create: { stellarAddress: event.rater },
      update: {},
    }),
    db.user.upsert({
      where: { stellarAddress: event.ratee },
      create: { stellarAddress: event.ratee },
      update: {},
    }),
  ]);

  await db.rating.upsert({
    where: { raterId_jobId: { raterId: rater.id, jobId: job.id } },
    create: {
      jobId: job.id,
      raterId: rater.id,
      rateeId: ratee.id,
      score: event.score,
    },
    // On-chain score wins; keep any comment the API stored.
    update: { rateeId: ratee.id, score: event.score },
  });

  return { status: "applied", jobId: job.id, score: event.score };
}

async function handleRated(
  escrowId: bigint | null,
  data: Record<string, unknown>,
  store: IndexerStore,
): Promise<void> {
  // `escrow_id` is the event's #[topic] field, so it is not in the data map;
  // without it the rating cannot be matched to a job.
  if (escrowId === null) return;

  const outcome = await applyRatedEvent(store as unknown as RatedStores, escrowId, data);

  if (outcome.status === "applied") {
    console.log("[indexer] rated job", outcome.jobId, "score", outcome.score);
    return;
  }

  if (outcome.reason === "unknown-job") {
    console.warn(
      `[indexer] rated event for escrow ${escrowId} has no job record; ` +
        "the rating cannot be stored until the job exists (see POST /api/escrow/sync/:jobId).",
    );
    return;
  }

  console.warn("[indexer] ignored a malformed rated event", data);
}
