/**
 * Route-level tests for `POST /api/reputation` — the duplicate-rating guard
 * added by issue #98.
 *
 * The chain is stubbed so nothing here talks to a network; the subject is the
 * API's own sequencing and error mapping.
 *
 *   - A second rating for the same (rater, job) pair returns 409 Conflict with
 *     a human-readable reason.
 *   - A concurrent race that slips past the `findUnique` guard (P2002) also
 *     surfaces as 409, never as 500.
 *   - A simulation failure is translated using the reputation error table, not
 *     echoed as a raw HostError string.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { SignJWT } from "jose";
import { Prisma } from "@prisma/client";

const RATER = Keypair.random().publicKey();
const RATEE = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();

process.env.REPUTATION_CONTRACT_ID =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK = "testnet";

const h = vi.hoisted(() => ({
  job: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  rating: {
    findUnique: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../db", () => ({ prisma: { job: h.job, user: h.user, rating: h.rating } }));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class FakeServer {
    async getAccount(address: string) {
      return new actual.Account(address, "1");
    }
    async simulateTransaction() {
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

beforeAll(async () => {
  const { reputationRouter } = await import("../routes/reputation");
  const { errorHandler } = await import("../middleware/errorHandler");
  const { jsonReplacer } = await import("../lib/json");

  const app = express();
  app.set("json replacer", jsonReplacer);
  app.use(express.json());
  app.use("/api/reputation", reputationRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(
  async () => new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  ),
);

beforeEach(() => {
  for (const fn of [
    h.job.findUnique,
    h.user.findUnique,
    h.rating.findUnique,
    h.rating.create,
    h.rating.findMany,
  ]) {
    fn.mockReset();
  }
  // Default: no existing rating.
  h.rating.findUnique.mockResolvedValue(null);
});

async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

const jobRow = () => ({
  id: "job_1",
  escrowId: 7n,
  status: "COMPLETED",
  client: { stellarAddress: RATER, id: "user_client" },
  freelancer: { stellarAddress: RATEE, id: "user_fl" },
});

async function postRating(body: unknown, address: string = RATER) {
  const res = await fetch(`${baseUrl}/api/reputation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await tokenFor(address)}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getAggregate(address: string) {
  const res = await fetch(`${baseUrl}/api/reputation/${address}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/reputation — duplicate rating handling", () => {
  beforeEach(() => {
    h.job.findUnique.mockResolvedValue(jobRow());
    // Rater and ratee are both found.
    h.user.findUnique.mockImplementation(({ where }: { where: { stellarAddress: string } }) =>
      Promise.resolve(
        where.stellarAddress === RATER
          ? { id: "user_client", stellarAddress: RATER, sessions: [] }
          : { id: "user_fl", stellarAddress: RATEE, sessions: [] },
      ),
    );
  });

  it("returns 201 and xdr on the first rating", async () => {
    h.rating.findUnique.mockResolvedValue(null);
    h.rating.create.mockResolvedValue({
      id: "rating_1",
      jobId: "job_1",
      raterId: "user_client",
      rateeId: "user_fl",
      score: 4,
      comment: null,
    });

    const res = await postRating({ jobId: "job_1", rateeAddress: RATEE, score: 4 });

    expect(res.status).toBe(201);
    expect(res.body.xdr).toBe("assembled-xdr");
    expect(h.rating.create).toHaveBeenCalledOnce();
  });

  it("returns 409 when an off-chain rating row already exists", async () => {
    // Simulate a previously-persisted (but maybe never submitted) row.
    h.rating.findUnique.mockResolvedValue({
      id: "rating_1",
      raterId: "user_client",
      jobId: "job_1",
    });

    const res = await postRating({ jobId: "job_1", rateeAddress: RATEE, score: 5 });

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/already rated/i);
    // Nothing was built: the check fires before the chain call.
    expect(h.rating.create).not.toHaveBeenCalled();
  });

  it("maps a concurrent P2002 unique-constraint violation to 409, not 500", async () => {
    // Both requests pass the `findUnique` guard at the same time; the second
    // write gets a Prisma unique-constraint error.
    h.rating.findUnique.mockResolvedValue(null);
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`raterId`,`jobId`)",
      { code: "P2002", clientVersion: "5.0.0", meta: {} },
    );
    h.rating.create.mockRejectedValue(p2002);

    const res = await postRating({ jobId: "job_1", rateeAddress: RATEE, score: 3 });

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/already rated/i);
  });

  it("lets the freelancer rate the client (the other direction)", async () => {
    h.rating.findUnique.mockResolvedValue(null);
    h.rating.create.mockResolvedValue({ id: "rating_2", score: 5 });

    const res = await postRating({ jobId: "job_1", rateeAddress: RATER, score: 5 }, RATEE);

    expect(res.status).toBe(201);
    expect(h.rating.create).toHaveBeenCalledWith({
      data: { jobId: "job_1", raterId: "user_fl", rateeId: "user_client", score: 5 },
    });
  });

  it("rejects a ratee who is not the job's other participant", async () => {
    const res = await postRating({ jobId: "job_1", rateeAddress: STRANGER, score: 5 });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/other participant/i);
    // Nothing was persisted: an invalid rating must not leave a row behind.
    expect(h.rating.create).not.toHaveBeenCalled();
  });

  it("rejects a caller who is not a participant", async () => {
    const res = await postRating({ jobId: "job_1", rateeAddress: RATEE, score: 5 }, STRANGER);

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/not a participant/i);
    expect(h.rating.create).not.toHaveBeenCalled();
  });

  it("rejects rating yourself", async () => {
    const res = await postRating({ jobId: "job_1", rateeAddress: RATER, score: 5 });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/other participant/i);
    expect(h.rating.create).not.toHaveBeenCalled();
  });

  it("returns 400 with a readable message when simulation fails with AlreadyRated (#5)", async () => {
    h.rating.findUnique.mockResolvedValue(null);
    // Override the SDK mock to return a simulation error for this test only.
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    // Re-mock just the simulation method to return an error.
    vi.spyOn(
      SorobanRpc.Server.prototype,
      "simulateTransaction",
    ).mockResolvedValueOnce({ error: "HostError: Error(Contract, #5)" } as never);

    const res = await postRating({ jobId: "job_1", rateeAddress: RATEE, score: 5 });

    expect(res.status).toBe(400);
    // The raw HostError is translated; no "Error(Contract" in the response.
    expect(String(res.body.error)).not.toMatch(/Error\(Contract/);
    expect(String(res.body.error)).toMatch(/already rated/i);
    expect(h.rating.create).not.toHaveBeenCalled();
  });
});

/**
 * `GET /api/reputation/:address` must mirror the contract's weighted aggregate
 * (#34), not average the raw rows: a rating on a large escrow weighs more, and
 * a second rating from the same rater does not count. These tests are the
 * off-chain counterpart of `contracts/reputation/src/test.rs`.
 */
describe("GET /api/reputation/:address — weighted aggregate", () => {
  const rating = (score: number, raterId: string, amount: string, asset = "USDC") => ({
    score,
    raterId,
    job: { totalAmount: amount, asset },
  });

  it("weights each rating by its escrow's total amount", async () => {
    // 5 on a 100-unit job and 3 on a 900-unit job: (500 + 2700) / 1000 = 3.2,
    // whereas an unweighted mean would report 4.
    h.rating.findMany.mockResolvedValue([
      rating(5, "user_a", "100"),
      rating(3, "user_b", "900"),
    ]);

    const res = await getAggregate(RATEE);

    expect(res.status).toBe(200);
    expect(res.body.averageScore).toBe(3.2);
    // The exact u64 fields the contract exposes: sum(score × weight), weight.
    expect(res.body.totalScore).toBe("32000000000");
    expect(res.body.weight).toBe("10000000000");
    expect(res.body.count).toBe(2);
    expect(res.body.totalRatings).toBe(2);
  });

  it("matches the contract's weighted example (5 on 100 + 1 on 900 = 1.4)", async () => {
    // The exact fixture `aggregate_weights_ratings_by_escrow_amount` asserts in
    // contracts/reputation/src/test.rs: 5*100 + 1*900 = 1_400 over weight 1_000.
    h.rating.findMany.mockResolvedValue([
      rating(5, "user_a", "100"),
      rating(1, "user_b", "900"),
    ]);

    const res = await getAggregate(RATEE);

    expect(res.body.totalScore).toBe("14000000000");
    expect(res.body.weight).toBe("10000000000");
    expect(res.body.averageScore).toBe(1.4);
    expect(res.body.count).toBe(2);
  });

  it("counts only the first rating from a given rater (anti-spam)", async () => {
    // The same rater's later rating on a much larger escrow is stored but does
    // not move the aggregate, exactly as `RatingCounted` does on chain.
    h.rating.findMany.mockResolvedValue([
      rating(5, "user_a", "100"),
      rating(1, "user_a", "1000"),
      rating(4, "user_b", "100"),
    ]);

    const res = await getAggregate(RATEE);

    expect(res.body.averageScore).toBe(4.5);
    expect(res.body.totalScore).toBe("9000000000");
    expect(res.body.weight).toBe("2000000000");
    expect(res.body.count).toBe(2);
    // Both rows exist, so the profile can still list every review.
    expect(res.body.totalRatings).toBe(3);
  });

  it("returns the zero aggregate for an address with no ratings", async () => {
    h.rating.findMany.mockResolvedValue([]);

    const res = await getAggregate(RATEE);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      address: RATEE,
      averageScore: 0,
      totalScore: "0",
      weight: "0",
      count: 0,
      totalRatings: 0,
    });
  });
});
