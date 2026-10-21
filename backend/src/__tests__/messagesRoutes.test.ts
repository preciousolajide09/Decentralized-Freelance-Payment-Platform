/**
 * messagesRoutes.test.ts
 *
 * Issue #64: messages are scoped to a job and readable only by its two
 * participants, unread counts are per job, and a read receipt only touches the
 * other party's messages.
 *
 * `prisma` is stubbed, so these assert the queries the routes make (who is
 * allowed, which rows are written) rather than storage behaviour.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { SignJWT } from "jose";

const CLIENT = Keypair.random().publicKey();
const FREELANCER = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();

const h = vi.hoisted(() => ({
  message: {
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    groupBy: vi.fn(),
  },
  job: {
    findUnique: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
}));

vi.mock("../db", () => ({ prisma: { message: h.message, job: h.job, user: h.user } }));

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { messagesRouter } = await import("../routes/messages");
  const { errorHandler } = await import("../middleware/errorHandler");
  const { jsonReplacer } = await import("../lib/json");

  const app = express();
  app.set("json replacer", jsonReplacer);
  app.use(express.json());
  app.use("/api/messages", messagesRouter);
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
  for (const fn of [
    h.message.findMany,
    h.message.create,
    h.message.updateMany,
    h.message.groupBy,
    h.job.findUnique,
    h.user.findUnique,
  ]) {
    fn.mockReset();
  }
  // `requireAuth` loads the caller's current session on every authenticated call.
  h.user.findUnique.mockResolvedValue({ id: "auth_user", sessions: [] });
});

async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function get(path: string, address: string) {
  const res = await fetch(`${baseUrl}/api/messages${path}`, {
    headers: { Authorization: `Bearer ${await tokenFor(address)}` },
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function post(path: string, address: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api/messages${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await tokenFor(address)}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** The job as `loadParticipantJob` reads it: both parties plus their row ids. */
function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    clientId: "user_client",
    freelancerId: "user_freelancer",
    client: { stellarAddress: CLIENT },
    freelancer: { stellarAddress: FREELANCER },
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "message_1",
    jobId: "job_1",
    senderId: "user_freelancer",
    body: "The first milestone is ready for review",
    createdAt: new Date(),
    readAt: null,
    ...overrides,
  };
}

describe("GET /api/messages/:jobId", () => {
  it("returns the conversation to a participant", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());
    h.message.findMany.mockResolvedValue([
      { ...messageRow(), sender: { stellarAddress: FREELANCER, displayName: null } },
    ]);

    const res = await get("/job_1", CLIENT);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sender.stellarAddress).toBe(FREELANCER);
    // The latest window is returned oldest first, so the view reads top to bottom.
    expect(h.message.findMany).toHaveBeenCalledWith({
      where: { jobId: "job_1" },
      take: 50,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { sender: { select: { stellarAddress: true, displayName: true } } },
    });
  });

  it("loads an older message window using a cursor", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());
    h.message.findMany.mockResolvedValue([
      messageRow({ id: "message_2" }),
      messageRow({ id: "message_1" }),
    ]);

    const res = await get("/job_1?limit=2&before=message_3", CLIENT);

    expect(res.status).toBe(200);
    expect(res.body.map((message: { id: string }) => message.id)).toEqual([
      "message_1",
      "message_2",
    ]);
    expect(h.message.findMany).toHaveBeenCalledWith({
      where: { jobId: "job_1" },
      cursor: { id: "message_3" },
      skip: 1,
      take: 2,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { sender: { select: { stellarAddress: true, displayName: true } } },
    });
  });

  it("rejects invalid pagination parameters", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());

    const res = await get("/job_1?limit=0", CLIENT);

    expect(res.status).toBe(400);
    expect(h.message.findMany).not.toHaveBeenCalled();
  });

  it("returns the conversation to the freelancer too", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());
    h.message.findMany.mockResolvedValue([]);

    const res = await get("/job_1", FREELANCER);

    expect(res.status).toBe(200);
  });

  it("refuses a third party without reading a single message", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());

    const res = await get("/job_1", STRANGER);

    expect(res.status).toBe(403);
    expect(h.message.findMany).not.toHaveBeenCalled();
  });

  it("404s an unknown job", async () => {
    h.job.findUnique.mockResolvedValue(null);

    const res = await get("/job_missing", CLIENT);

    expect(res.status).toBe(404);
    expect(h.message.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/messages/:jobId", () => {
  it("stores the message against the sender the caller matched, not a body field", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());
    h.message.create.mockResolvedValue(messageRow({ senderId: "user_client" }));

    const res = await post("/job_1", CLIENT, {
      body: "  Please share the latest screenshots.  ",
      // A sender the caller is not: the route must ignore it.
      senderId: "user_freelancer",
    });

    expect(res.status).toBe(201);
    expect(h.message.create).toHaveBeenCalledWith({
      data: { jobId: "job_1", senderId: "user_client", body: "Please share the latest screenshots." },
    });
  });

  it("attributes a freelancer's message to the freelancer", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());
    h.message.create.mockResolvedValue(messageRow());

    const res = await post("/job_1", FREELANCER, { body: "Starting now." });

    expect(res.status).toBe(201);
    expect(h.message.create.mock.calls[0][0].data.senderId).toBe("user_freelancer");
  });

  it("rejects an empty or whitespace-only body", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());

    for (const body of ["", "   ", "\n"]) {
      const res = await post("/job_1", CLIENT, { body });
      expect(res.status).toBe(400);
    }
    expect(h.message.create).not.toHaveBeenCalled();
  });

  it("refuses a third party", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());

    const res = await post("/job_1", STRANGER, { body: "Hello?" });

    expect(res.status).toBe(403);
    expect(h.message.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/messages/:jobId/read", () => {
  it("marks only the other party's unread messages", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());
    h.message.updateMany.mockResolvedValue({ count: 2 });

    const res = await post("/job_1/read", CLIENT);

    expect(res.status).toBe(200);
    expect(res.body.markedRead).toBe(2);
    const call = h.message.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      jobId: "job_1",
      readAt: null,
      sender: { stellarAddress: { not: CLIENT } },
    });
    expect(call.data.readAt).toBeInstanceOf(Date);
  });

  it("refuses a third party", async () => {
    h.job.findUnique.mockResolvedValue(jobRow());

    const res = await post("/job_1/read", STRANGER);

    expect(res.status).toBe(403);
    expect(h.message.updateMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/messages/unread", () => {
  it("totals the per-job unread counts for the caller", async () => {
    h.message.groupBy.mockResolvedValue([
      { jobId: "job_1", _count: { _all: 2 } },
      { jobId: "job_2", _count: { _all: 1 } },
    ]);

    const res = await get("/unread", FREELANCER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 3,
      byJob: [
        { jobId: "job_1", count: 2 },
        { jobId: "job_2", count: 1 },
      ],
    });

    // Counted in the database, and only for jobs the caller is in and messages
    // the caller did not send.
    const call = h.message.groupBy.mock.calls[0][0];
    expect(call.by).toEqual(["jobId"]);
    expect(call._count).toEqual({ _all: true });
    expect(call.where.readAt).toBeNull();
    expect(call.where.sender).toEqual({ stellarAddress: { not: FREELANCER } });
    expect(call.where.job.OR).toEqual([
      { client: { stellarAddress: FREELANCER } },
      { freelancer: { stellarAddress: FREELANCER } },
    ]);
  });

  it("is not mistaken for a job id", async () => {
    h.message.groupBy.mockResolvedValue([]);

    const res = await get("/unread", CLIENT);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, byJob: [] });
    // The job lookup belongs to /:jobId, which /unread must not fall through to.
    expect(h.job.findUnique).not.toHaveBeenCalled();
  });
});
