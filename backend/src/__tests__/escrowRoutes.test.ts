/**
 * Validation tests for the `/api/escrow` build routes (issue #49).
 *
 * The bug these pin down: the build routes validated `escrowId` with
 * `z.number()`, which also accepts a fraction. A value such as `1.5` sailed
 * through validation and then reached `BigInt(1.5)` in the handler, where it
 * threw a `RangeError` — so a malformed request answered 500 instead of 400.
 *
 * The contract the routes now honour, asserted here per route:
 *   - a fractional id   → 400, not 500;
 *   - a negative id     → 400;
 *   - a non-numeric id  → 400;
 *   - a well-formed id  → accepted (the tx is built);
 *   - id 0              → accepted, because the contract's first escrow is id 0.
 *
 * The chain is stubbed (see the `@stellar/stellar-sdk` mock below), so nothing
 * here talks to a network: the subject is the API's own validation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { SignJWT } from "jose";
import { FUNDED_JOB_STATUS } from "../lib/jobStatus";
import type { IndexerStore } from "../indexer";

const CLIENT = Keypair.random().publicKey();
// A real contract strkey: `new Contract(...)` validates the id before the
// stubbed server ever sees the call.
const ESCROW_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

process.env.ESCROW_CONTRACT_ID = ESCROW_CONTRACT;
process.env.XLM_CONTRACT_ID = ESCROW_CONTRACT;
process.env.JWT_SECRET = "test_secret_that_is_at_least_32_chars_long!";

/** Every transaction the routes asked the chain to build, in order. */
const builtTxs = vi.hoisted(() => [] as unknown[]);

const h = vi.hoisted(() => ({
  job: { update: vi.fn(), findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  buildCreateArgs: vi.fn(),
}));

vi.mock("../db", () => ({ prisma: { job: h.job, user: h.user } }));

vi.mock("../lib/escrowArgs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/escrowArgs")>();
  return {
    ...actual,
    buildCreateArgs: (...args: Parameters<typeof actual.buildCreateArgs>) => {
      h.buildCreateArgs(...args);
      return actual.buildCreateArgs(...args);
    },
  };
});

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  // The real pipeline needs a funded account and a live RPC node; these tests
  // only need to know whether the handler got far enough to build a call.
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
// imports `config`, which reads the contract ids out of the environment at
// import time — and those are set above.
beforeAll(async () => {
  const { escrowRouter } = await import("../routes/escrow");
  const { errorHandler } = await import("../middleware/errorHandler");
  const { jsonReplacer } = await import("../lib/json");

  const app = express();
  // Mirrors app.ts: Prisma ids are BigInt, which JSON.stringify throws on.
  app.set("json replacer", jsonReplacer);
  app.use(express.json());
  app.use("/api/escrow", escrowRouter);
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
  h.job.update.mockReset();
  h.job.findUnique.mockReset();
  h.user.findUnique.mockReset();
  h.buildCreateArgs.mockReset();
  // `requireAuth` loads the caller's current session before the request handler.
  h.user.findUnique.mockResolvedValue({ id: "auth_user", sessions: [] });
});

/** A bearer token the `requireAuth` middleware accepts for `address`. */
async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function post(path: string, body: unknown = {}) {
  const res = await fetch(`${baseUrl}/api/escrow${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await tokenFor(CLIENT)}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// Each build route plus the extra body fields it needs beyond `escrowId`.
const BUILD_ROUTES: Array<[string, Record<string, unknown>]> = [
  ["/build/fund", {}],
  ["/build/release", { milestoneIndex: 0 }],
  ["/build/reclaim", {}],
  ["/build/reclaim-dispute", {}],
];

for (const [path, extra] of BUILD_ROUTES) {
  describe(`POST /api/escrow${path} — escrowId validation`, () => {
    it("rejects a fractional id with 400, not 500", async () => {
      const res = await post(path, { escrowId: 1.5, ...extra });
      expect(res.status).toBe(400);
      // The handler never ran, so no doomed transaction was built.
      expect(builtTxs).toHaveLength(0);
    });

    it("rejects a negative id with 400", async () => {
      const res = await post(path, { escrowId: -1, ...extra });
      expect(res.status).toBe(400);
      expect(builtTxs).toHaveLength(0);
    });

    it("rejects a non-numeric id with 400", async () => {
      const res = await post(path, { escrowId: "not-an-id", ...extra });
      expect(res.status).toBe(400);
    });

    it("rejects a missing id with 400", async () => {
      const res = await post(path, extra);
      expect(res.status).toBe(400);
    });

    it("accepts a well-formed id and builds the call", async () => {
      const res = await post(path, { escrowId: 7, ...extra });
      expect(res.status).toBe(200);
      expect(res.body.xdr).toBe("assembled-xdr");
      expect(builtTxs).toHaveLength(1);
    });
  });
}

describe("escrowId validation — zero-based ids", () => {
  it("accepts id 0, the first id the contract assigns", async () => {
    // `next_id` returns 0 for the first escrow (contracts/escrow/src/test.rs
    // asserts it), so a `.positive()` check would 400 a real escrow.
    const res = await post("/build/fund", { escrowId: 0 });
    expect(res.status).toBe(200);
    expect(res.body.xdr).toBe("assembled-xdr");
  });
});

describe("POST /api/escrow/build/create — job asset", () => {
  const job = {
    asset: "XLM",
    client: { stellarAddress: CLIENT },
    milestones: [{ amount: { toString: () => "0.1" }, deadline: null }],
  };

  it("encodes the configured SAC and asset precision from the job", async () => {
    h.job.findUnique.mockResolvedValue(job);

    const res = await post("/build/create", {
      jobId: "job_1",
      freelancerAddress: CLIENT,
      expiryTimestamp: 2_000,
    });

    expect(res.status).toBe(200);
    expect(h.buildCreateArgs).toHaveBeenCalledWith(
      expect.objectContaining({
        token: ESCROW_CONTRACT,
        milestones: [{ amount: 1_000_000n, deadline: 2_000n }],
      }),
    );
  });

  it("rejects an asset not in the registry with a clear client error", async () => {
    h.job.findUnique.mockResolvedValue({ ...job, asset: "DOGE" });

    const res = await post("/build/create", {
      jobId: "job_1",
      freelancerAddress: CLIENT,
      expiryTimestamp: 2_000,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unknown asset: DOGE");
    expect(h.buildCreateArgs).not.toHaveBeenCalled();
  });
});

describe("POST /api/escrow/sync/:jobId — escrowId validation", () => {
  it("rejects a fractional id with 400 before touching the database", async () => {
    const res = await post("/sync/job_1", { escrowId: 1.5 });
    expect(res.status).toBe(400);
    expect(h.job.update).not.toHaveBeenCalled();
  });

  it("records a well-formed id", async () => {
    h.job.findUnique.mockResolvedValue({ id: "job_1", client: { stellarAddress: CLIENT } });
    h.job.update.mockResolvedValue({ id: "job_1", escrowId: 7n, status: FUNDED_JOB_STATUS });

    const res = await post("/sync/job_1", { escrowId: 7 });

    expect(res.status).toBe(200);
    expect(h.job.update).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: { escrowId: 7n, status: FUNDED_JOB_STATUS },
    });
    // The response the client sees carries the same status the indexer's
    // `funded` handler writes, so a subsequent indexer pass is a no-op (#43).
    expect(res.body.status).toBe("ACTIVE");
  });

  it("agrees with the indexer's funded handler on one status", async () => {
    // Simulates the event arriving after the sync: the job must not flip.
    h.job.findUnique.mockResolvedValue({ id: "job_1", client: { stellarAddress: CLIENT } });
    h.job.update.mockResolvedValue({ id: "job_1", escrowId: 7n, status: "ACTIVE" });

    await post("/sync/job_1", { escrowId: 7 });
    const synced = h.job.update.mock.calls.at(-1)?.[0].data.status;

    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const store = { job: { updateMany } } as unknown as IndexerStore;
    const { handleFunded } = await import("../indexer");
    await handleFunded(7n, store);
    const indexed = updateMany.mock.calls.at(-1)?.[0].data.status;

    expect(synced).toBe(indexed);
    expect(synced).toBe("ACTIVE");
  });
});
