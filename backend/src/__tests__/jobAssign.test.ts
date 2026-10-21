import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { SignJWT } from "jose";
import { assignJobSchema } from "../lib/schemas";

const CLIENT = Keypair.random().publicKey();
const FREELANCER = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();

const db = vi.hoisted(() => ({
  job: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
  // Assignment also accepts the winning application and rejects the rest.
  proposal: {
    updateMany: vi.fn(),
  },
}));

vi.mock("../db", () => ({ prisma: db }));

describe("assignJobSchema", () => {
  it("accepts checksum-valid Stellar G addresses", () => {
    expect(assignJobSchema.safeParse({ freelancerAddress: CLIENT }).success).toBe(true);
    expect(assignJobSchema.safeParse({ freelancerAddress: FREELANCER }).success).toBe(true);
  });

  it("rejects non-Stellar or invalid addresses", () => {
    expect(assignJobSchema.safeParse({ freelancerAddress: "" }).success).toBe(false);
    expect(assignJobSchema.safeParse({ freelancerAddress: "not-an-address" }).success).toBe(false);
    // Contract address C... is not an ed25519 account address G...
    expect(
      assignJobSchema.safeParse({
        freelancerAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      }).success,
    ).toBe(false);
    // Bad checksum
    const badChecksum = CLIENT.endsWith("A")
      ? CLIENT.slice(0, -1) + "B"
      : CLIENT.slice(0, -1) + "A";
    expect(
      assignJobSchema.safeParse({ freelancerAddress: badChecksum }).success,
    ).toBe(false);
    // Missing field
    expect(assignJobSchema.safeParse({}).success).toBe(false);
  });
});

describe("PUT /api/jobs/:id/assign", () => {
  let baseUrl: string;
  let server: Server;

  beforeAll(async () => {
    const { jobsRouter } = await import("../routes/jobs");
    const { errorHandler } = await import("../middleware/errorHandler");

    const app = express();
    app.use(express.json());
    app.use("/api/jobs", jobsRouter);
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
    db.job.findUnique.mockReset();
    db.job.update.mockReset();
    db.user.findUnique.mockReset();
    // `requireAuth` loads the caller's current session before the handler runs.
    // A route-level freelancer lookup (no session select) still defaults to null.
    db.user.findUnique.mockImplementation(
      ({ where, select }: { where: { stellarAddress: string }; select?: { sessions?: unknown } }) =>
        Promise.resolve(
          select?.sessions
            ? { id: `auth_${where.stellarAddress}`, sessions: [] }
            : null,
        ),
    );
  });

  async function tokenFor(address: string): Promise<string> {
    return new SignJWT({ sub: address })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }

  it("returns 401 when authorization header is missing", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/job_1/assign`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freelancerAddress: FREELANCER }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Missing authorization header/);
  });

  it("returns 400 when freelancerAddress fails validation", async () => {
    const token = await tokenFor(CLIENT);
    const res = await fetch(`${baseUrl}/api/jobs/job_1/assign`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ freelancerAddress: "invalid-address" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid Stellar address/);
    expect(db.job.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when job does not exist", async () => {
    db.job.findUnique.mockResolvedValue(null);
    const token = await tokenFor(CLIENT);

    const res = await fetch(`${baseUrl}/api/jobs/job_missing/assign`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ freelancerAddress: FREELANCER }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Job not found");
  });

  it("returns 403 when caller is not the job's client", async () => {
    db.job.findUnique.mockResolvedValue({
      id: "job_1",
      clientId: "client_user_id",
      client: { stellarAddress: CLIENT },
      freelancerId: null,
    });
    const token = await tokenFor(STRANGER);

    const res = await fetch(`${baseUrl}/api/jobs/job_1/assign`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ freelancerAddress: FREELANCER }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Only the client can assign a freelancer");
  });

  it("returns 400 when the job is already assigned to a freelancer", async () => {
    db.job.findUnique.mockResolvedValue({
      id: "job_1",
      clientId: "client_user_id",
      client: { stellarAddress: CLIENT },
      freelancerId: "existing_freelancer_id",
    });
    const token = await tokenFor(CLIENT);

    const res = await fetch(`${baseUrl}/api/jobs/job_1/assign`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ freelancerAddress: FREELANCER }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Job is already assigned to a freelancer");
    // The auth lookup is expected; the handler must not go on to look the new
    // freelancer up.
    expect(
      db.user.findUnique.mock.calls.some(
        ([args]) =>
          (args as { where?: { stellarAddress?: string } }).where?.stellarAddress === FREELANCER,
      ),
    ).toBe(false);
    expect(db.job.update).not.toHaveBeenCalled();
  });

  it("returns 400 when client attempts to assign themselves as freelancer", async () => {
    db.job.findUnique.mockResolvedValue({
      id: "job_1",
      clientId: "client_user_id",
      client: { stellarAddress: CLIENT },
      freelancerId: null,
    });
    const token = await tokenFor(CLIENT);

    const res = await fetch(`${baseUrl}/api/jobs/job_1/assign`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ freelancerAddress: CLIENT }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Client cannot be assigned as freelancer to their own job");
    // Only the auth lookup runs; the handler rejects before resolving a profile.
    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
    expect(db.job.update).not.toHaveBeenCalled();
  });

  it("returns 404 when freelancer address is valid but not registered in the system", async () => {
    db.job.findUnique.mockResolvedValue({
      id: "job_1",
      clientId: "client_user_id",
      client: { stellarAddress: CLIENT },
      freelancerId: null,
    });
    db.user.findUnique.mockImplementation(
      ({ select }: { select?: { sessions?: unknown } }) =>
        Promise.resolve(select?.sessions ? { id: "auth_client", sessions: [] } : null),
    );
    const token = await tokenFor(CLIENT);

    const res = await fetch(`${baseUrl}/api/jobs/job_1/assign`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ freelancerAddress: FREELANCER }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Freelancer not found");
    expect(db.job.update).not.toHaveBeenCalled();
  });

  it("assigns freelancer successfully and updates database record", async () => {
    db.job.findUnique.mockResolvedValue({
      id: "job_1",
      clientId: "client_user_id",
      client: { stellarAddress: CLIENT },
      freelancerId: null,
    });
    db.user.findUnique.mockImplementation(
      ({ select }: { select?: { sessions?: unknown } }) =>
        Promise.resolve(
          select?.sessions
            ? { id: "auth_client", sessions: [] }
            : { id: "freelancer_user_id", stellarAddress: FREELANCER },
        ),
    );
    db.job.update.mockResolvedValue({
      id: "job_1",
      clientId: "client_user_id",
      freelancerId: "freelancer_user_id",
    });
    const token = await tokenFor(CLIENT);

    const res = await fetch(`${baseUrl}/api/jobs/job_1/assign`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ freelancerAddress: FREELANCER }),
    });

    expect(res.status).toBe(200);
    const updated = (await res.json()) as { id: string; freelancerId: string };
    expect(updated.freelancerId).toBe("freelancer_user_id");
    expect(db.job.update).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: { freelancerId: "freelancer_user_id" },
    });
  });
});
