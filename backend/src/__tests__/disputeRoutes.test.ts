/**
 * Route-level tests for `/api/disputes` — the parts of issue #86 that live in
 * the API rather than in the indexer.
 *
 * The chain is stubbed (see the `@stellar/stellar-sdk` mock), so nothing here
 * talks to a network: the subject is the API's own sequencing.
 *
 *   - `POST /` records the reason (the only copy of it that exists) on a row
 *     keyed on the job, before the contract has minted an id;
 *   - `POST /:id/raise` builds `dispute.raise(escrow_id, escrow_contract,
 *     raised_by, reason)` with the escrow contract — not the id — and the
 *     *stored* reason, so the string the panel reads cannot drift from the
 *     string the contract received;
 *   - `POST /:id/sync` records the id, and `POST /:id/resolve` — a 409 before
 *     that — builds `arbitrate` once it exists.
 *
 * The last test is the API-side proof of the issue: `dispute.raise` is the call
 * the platform never made, and the resolve that depended on it now succeeds.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { Address, Keypair, scValToNative } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { SignJWT } from "jose";

// Addresses must be real account strkeys because the routes encode them; the
// contract ids must be real contract strkeys. Both are generated rather than
// fixed, since nothing about their values is under test.

const CLIENT = Keypair.random().publicKey();
const FREELANCER = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();
const ARBITRATOR = Keypair.random().publicKey();
// The escrow contract is both the cross-call target and (here) the dispute
// contract's own id.
const ESCROW_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

process.env.ESCROW_CONTRACT_ID = ESCROW_CONTRACT;
process.env.DISPUTE_CONTRACT_ID = ESCROW_CONTRACT;
process.env.ARBITRATOR_ADDRESSES = ARBITRATOR;

/** Every transaction the routes asked the chain to build, in order. */
const builtTxs = vi.hoisted(() => [] as unknown[]);

const h = vi.hoisted(() => ({
  dispute: {
    upsert: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  job: {
    findUnique: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
}));

vi.mock("../db", () => ({ prisma: { dispute: h.dispute, job: h.job, user: h.user } }));

// `getAsset` is wrapped rather than replaced so the registry stays real for
// every test; one test overrides it with a non-7-decimal asset, which the
// current registry does not ship, to prove the route reads the job's decimals
// instead of a hardcoded 1e7 (issue #35).
vi.mock("../lib/assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/assets")>();
  return { ...actual, getAsset: vi.fn(actual.getAsset) };
});

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  // The real pipeline needs a funded account and a live RPC node; these tests
  // only need the transaction it produced. A real `Account` keeps the real
  // `TransactionBuilder` running, and every simulated tx is captured so the
  // invocation and its arguments can be decoded below.
  class FakeServer {
    async getAccount(address: string) {
      return new actual.Account(address, "1");
    }

    async simulateTransaction(tx: unknown) {
      builtTxs.push(tx);
      return { result: { retval: actual.xdr.ScVal.scvVoid() } };
    }
  }

  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: FakeServer,
      assembleTransaction: () => ({ build: () => ({ toXDR: () => "assembled-xdr" }) }),
    },
  };
});

let baseUrl: string;
let server: Server;

// The router is imported here rather than at the top of the file because it
// imports `config`, which reads the contract ids and the arbitrator allowlist
// out of the environment at import time — and those are set above.
beforeAll(async () => {
  const { disputesRouter } = await import("../routes/disputes");
  const { errorHandler } = await import("../middleware/errorHandler");
  const { jsonReplacer } = await import("../lib/json");

  const app = express();
  // Mirrors app.ts: Prisma ids are BigInt, which JSON.stringify throws on.
  app.set("json replacer", jsonReplacer);
  app.use(express.json());
  app.use("/api/disputes", disputesRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  builtTxs.length = 0;
  for (const fn of [
    h.dispute.upsert,
    h.dispute.update,
    h.dispute.findUnique,
    h.dispute.findFirst,
    h.job.findUnique,
    h.user.findUnique,
  ]) {
    fn.mockReset();
  }
  // `requireAuth` loads the caller's current session before the request handler.
  h.user.findUnique.mockImplementation(
    ({ where, select }: { where: { stellarAddress: string }; select?: { sessions?: unknown } }) =>
      Promise.resolve(
        select?.sessions
          ? { id: `auth_${where.stellarAddress}`, sessions: [] }
          : { id: `user_${where.stellarAddress}`, stellarAddress: where.stellarAddress },
      ),
  );
});

/** A bearer token the `requireAuth` middleware accepts for `address`. */
async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

/** The stored dispute, with its job and both parties, as the routes load it. */
function disputeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dispute_1",
    jobId: "job_1",
    onChainId: null,
    raisedByAddress: CLIENT,
    reason: "The final milestone was never delivered",
    status: "PENDING",
    clientShare: null,
    freelancerShare: null,
    createdAt: new Date(),
    resolvedAt: null,
    job: {
      id: "job_1",
      escrowId: 7n,
      asset: "USDC",
      client: { stellarAddress: CLIENT },
      freelancer: { stellarAddress: FREELANCER },
    },
    ...overrides,
  };
}

/** The job `POST /` authorizes the caller against. */
const jobRow = () => ({
  id: "job_1",
  escrowId: 7n,
  client: { stellarAddress: CLIENT },
  freelancer: { stellarAddress: FREELANCER },
});

async function post(path: string, address: string, body: unknown = {}) {
  const res = await fetch(`${baseUrl}/api/disputes${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await tokenFor(address)}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string) {
  const res = await fetch(`${baseUrl}/api/disputes${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * The contract name, address and decoded arguments of the last transaction the
 * routes built — an assertion on the call the platform makes, not merely that
 * something was built.
 */
function lastInvocation(): { contract: string; name: string; args: unknown[] } {
  const tx = builtTxs.at(-1) as Transaction;
  const op = tx.toEnvelope().v1().tx().operations()[0];
  const invoke = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
  return {
    contract: Address.fromScAddress(invoke.contractAddress()).toString(),
    name: invoke.functionName().toString(),
    args: invoke.args().map((arg) => scValToNative(arg)),
  };
}

describe("POST /api/disputes", () => {
  beforeEach(() => h.job.findUnique.mockResolvedValue(jobRow()));

  it("records the reason before the chain has minted an id", async () => {
    h.dispute.upsert.mockResolvedValue(disputeRow());

    const res = await post("/", CLIENT, {
      jobId: "job_1",
      reason: "The final milestone was never delivered",
    });

    expect(res.status).toBe(201);
    // Keyed on the job, not on an id that does not exist yet: that key is what
    // keeps the row single when `dispute.raise` later attaches one.
    expect(h.dispute.upsert).toHaveBeenCalledWith({
      where: { jobId: "job_1" },
      create: {
        jobId: "job_1",
        raisedByAddress: CLIENT,
        reason: "The final milestone was never delivered",
        // The row is an intent until `dispute.raise` confirms (#32).
        status: "PENDING",
      },
      update: {},
    });
    expect(res.body.xdr).toBe("assembled-xdr");
    // Step 1 only: `dispute.raise` is a separate transaction, built by /raise.
    expect(lastInvocation()).toMatchObject({ contract: ESCROW_CONTRACT, name: "open_dispute" });
  });

  it("refuses a stranger", async () => {
    const res = await post("/", STRANGER, {
      jobId: "job_1",
      reason: "I am not a party to this job",
    });

    expect(res.status).toBe(403);
    expect(h.dispute.upsert).not.toHaveBeenCalled();
    expect(builtTxs).toHaveLength(0);
  });

  it("rejects a reason shorter than the 10 characters the panel needs", async () => {
    const res = await post("/", CLIENT, { jobId: "job_1", reason: "too short" });

    expect(res.status).toBe(400);
    expect(h.dispute.upsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/disputes/:id", () => {
  it("hides a dispute that was built but never submitted", async () => {
    // The row exists (with its reason) but has no on-chain id, so it is the
    // phantom dispute #32 describes. The route must not report it.
    h.dispute.findFirst.mockResolvedValue(null);

    const res = await get("/dispute_1");

    expect(res.status).toBe(404);
    expect(h.dispute.findFirst).toHaveBeenCalledWith({
      where: { id: "dispute_1", onChainId: { not: null } },
      include: { job: true },
    });
  });

  it("returns the dispute once the on-chain id is recorded", async () => {
    h.dispute.findFirst.mockResolvedValue(disputeRow({ onChainId: 3n, status: "RAISED" }));

    const res = await get("/dispute_1");

    expect(res.status).toBe(200);
    expect(res.body.onChainId).toBe("3");
  });
});

describe("POST /api/disputes/:id/raise", () => {
  beforeEach(() => h.dispute.findUnique.mockResolvedValue(disputeRow()));

  it("builds dispute.raise with the escrow contract and the stored reason", async () => {
    const res = await post("/dispute_1/raise", CLIENT);

    expect(res.status).toBe(200);
    expect(res.body.xdr).toBe("assembled-xdr");

    expect(lastInvocation()).toEqual({
      contract: ESCROW_CONTRACT,
      name: "raise",
      args: [
        7n,
        // The escrow *contract* address, because `raise` cross-calls it to check
        // the escrow is Disputed and the raiser is a party.
        ESCROW_CONTRACT,
        CLIENT,
        // The reason comes back out of the row, not from the request body.
        "The final milestone was never delivered",
      ],
    });
  });

  it("is available to the freelancer too", async () => {
    const res = await post("/dispute_1/raise", FREELANCER);

    expect(res.status).toBe(200);
    expect(lastInvocation().args[2]).toBe(FREELANCER);
  });

  it("refuses a stranger", async () => {
    const res = await post("/dispute_1/raise", STRANGER);

    expect(res.status).toBe(403);
    expect(builtTxs).toHaveLength(0);
  });

  it("refuses to raise a dispute that is already on-chain", async () => {
    h.dispute.findUnique.mockResolvedValue(disputeRow({ onChainId: 3n }));

    const res = await post("/dispute_1/raise", CLIENT);

    expect(res.status).toBe(409);
    expect(builtTxs).toHaveLength(0);
  });
});

describe("POST /api/disputes/:id/sync", () => {
  beforeEach(() => h.dispute.findUnique.mockResolvedValue(disputeRow()));

  it("records the id dispute.raise returned", async () => {
    h.dispute.update.mockResolvedValue(disputeRow({ onChainId: 3n }));

    const res = await post("/dispute_1/sync", CLIENT, { onChainId: 3 });

    expect(res.status).toBe(200);
    expect(res.body.onChainId).toBe("3");
    expect(h.dispute.update).toHaveBeenCalledWith({
      where: { id: "dispute_1" },
      data: { onChainId: 3n, status: "RAISED" },
    });
  });

  it("refuses a stranger", async () => {
    const res = await post("/dispute_1/sync", STRANGER, { onChainId: 3 });

    expect(res.status).toBe(403);
    expect(h.dispute.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/disputes/:id/resolve", () => {
  const split = { clientShare: 2.5, freelancerShare: 0 };

  it("refuses while the dispute has no on-chain id, and says what to call", async () => {
    h.dispute.findUnique.mockResolvedValue(disputeRow());

    const res = await post("/dispute_1/resolve", ARBITRATOR, split);

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/raise/);
    expect(String(res.body.error)).toMatch(/sync/);
    // Nothing was built: arbitrate has no id to key on.
    expect(builtTxs).toHaveLength(0);
    expect(h.dispute.update).not.toHaveBeenCalled();
  });

  it("builds arbitrate once the id is recorded — the path #86 made unreachable", async () => {
    // The sequence the flow requires: the API row, the id `dispute.raise`
    // returned, then a ruling.
    h.dispute.findUnique.mockResolvedValue(disputeRow({ onChainId: 3n }));
    h.dispute.update.mockResolvedValue(disputeRow({ onChainId: 3n, status: "UNDER_REVIEW" }));

    const res = await post("/dispute_1/resolve", ARBITRATOR, split);

    expect(res.status).toBe(200);
    expect(res.body.xdr).toBe("assembled-xdr");
    expect(lastInvocation()).toEqual({
      contract: ESCROW_CONTRACT,
      name: "arbitrate",
      // The on-chain dispute id the raise returned, and the split in stroops.
      args: [3n, 25_000_000n, 0n],
    });
    expect(h.dispute.update).toHaveBeenCalledWith({
      where: { id: "dispute_1" },
      data: { status: "UNDER_REVIEW", clientShare: 2.5, freelancerShare: 0 },
    });
  });

  it("converts shares with the job's asset decimals, not a hardcoded 1e7", async () => {
    // A 2-decimal asset: 2.5 whole units is 250 base units, where the old
    // `Math.round(share * 1e7)` would have produced 25,000,000.
    const { getAsset } = await import("../lib/assets");
    vi.mocked(getAsset).mockReturnValueOnce({
      symbol: "TST",
      decimals: 2,
      configKey: "USDC_CONTRACT_ID",
    });
    h.dispute.findUnique.mockResolvedValue(
      disputeRow({
        onChainId: 3n,
        job: {
          id: "job_1",
          escrowId: 7n,
          asset: "TST",
          client: { stellarAddress: CLIENT },
          freelancer: { stellarAddress: FREELANCER },
        },
      }),
    );
    h.dispute.update.mockResolvedValue(disputeRow({ onChainId: 3n }));

    const res = await post("/dispute_1/resolve", ARBITRATOR, split);

    expect(res.status).toBe(200);
    expect(lastInvocation().args).toEqual([3n, 250n, 0n]);
  });

  it("rejects a job whose asset the registry does not know", async () => {
    h.dispute.findUnique.mockResolvedValue(
      disputeRow({
        onChainId: 3n,
        job: {
          id: "job_1",
          escrowId: 7n,
          asset: "NOPE",
          client: { stellarAddress: CLIENT },
          freelancer: { stellarAddress: FREELANCER },
        },
      }),
    );

    const res = await post("/dispute_1/resolve", ARBITRATOR, split);

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Unknown asset/);
    expect(builtTxs).toHaveLength(0);
    expect(h.dispute.update).not.toHaveBeenCalled();
  });

  it("refuses a non-arbitrator before it builds anything", async () => {
    h.dispute.findUnique.mockResolvedValue(disputeRow({ onChainId: 3n }));

    const res = await post("/dispute_1/resolve", CLIENT, split);

    expect(res.status).toBe(403);
    expect(builtTxs).toHaveLength(0);
  });
});
