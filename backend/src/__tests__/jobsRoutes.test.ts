/**
 * jobsRoutes.test.ts
 *
 * Issue #70: jobs carry curated skill tags, the list can be filtered by one,
 * and the taxonomy itself is served so a client does not have to hardcode it.
 * Issue #71: a user can bookmark a job and read their own bookmark list.
 *
 * `prisma` is stubbed, so these assert the queries the routes build (which
 * filter reaches the database, whose bookmarks are read) rather than storage
 * behaviour.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { SignJWT } from "jose";
import { SKILL_TAGS } from "../lib/tags";

const CLIENT = Keypair.random().publicKey();

const h = vi.hoisted(() => ({
  job: {
    findMany: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  user: { findUnique: vi.fn() },
  savedJob: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
}));

vi.mock("../db", () => ({
  prisma: { job: h.job, user: h.user, savedJob: h.savedJob },
}));

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { jobsRouter } = await import("../routes/jobs");
  const { errorHandler } = await import("../middleware/errorHandler");
  const { jsonReplacer } = await import("../lib/json");

  const app = express();
  app.set("json replacer", jsonReplacer);
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
  for (const fn of [
    h.job.findMany,
    h.job.create,
    h.job.findUnique,
    h.job.update,
    h.user.findUnique,
    h.savedJob.findMany,
    h.savedJob.upsert,
    h.savedJob.deleteMany,
  ]) {
    fn.mockReset();
  }
  h.job.findMany.mockResolvedValue([]);
  // `requireAuth` asks for the caller's session; the save/unsave handlers ask
  // for the caller's row. Distinguish the two by the `select` shape.
  h.user.findUnique.mockImplementation(({ select }: { select?: { sessions?: unknown } }) =>
    Promise.resolve(select?.sessions ? { id: "user_client", sessions: [] } : { id: "user_client" }),
  );
  h.job.findUnique.mockResolvedValue({ id: "job_1" });
});

async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function get(path: string) {
  const res = await fetch(`${baseUrl}/api/jobs${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

async function getAuthed(path: string, address = CLIENT) {
  const res = await fetch(`${baseUrl}/api/jobs${path}`, {
    headers: { Authorization: `Bearer ${await tokenFor(address)}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

async function post(body: unknown, address = CLIENT) {
  const res = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await tokenFor(address)}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function sendWithToken(method: string, path: string, address = CLIENT) {
  const res = await fetch(`${baseUrl}/api/jobs${path}`, {
    method,
    headers: { Authorization: `Bearer ${await tokenFor(address)}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

const validJob = () => ({
  title: "Landing page redesign",
  description: "A longer description of the work",
  milestones: [{ amount: "1.5" }],
});

describe("GET /api/jobs/tags", () => {
  it("serves the curated taxonomy", async () => {
    const res = await get("/tags");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(SKILL_TAGS.length);
    expect(res.body[0]).toMatchObject({ slug: "web-development", category: "Development" });
    expect(res.body[0].label).toBeTruthy();
  });

  it("is not mistaken for a job id", async () => {
    await get("/tags");

    // The `/:id` handler would look a job up; the literal route must win.
    expect(h.job.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/jobs?tag=", () => {
  it("filters with array containment", async () => {
    await get("/?tag=smart-contracts");

    expect(h.job.findMany).toHaveBeenCalledTimes(1);
    expect(h.job.findMany.mock.calls[0][0].where).toEqual({
      tags: { has: "smart-contracts" },
    });
  });

  it("combines the tag filter with the status filter", async () => {
    await get("/?status=ACTIVE&tag=web-development");

    expect(h.job.findMany.mock.calls[0][0].where).toEqual({
      status: "ACTIVE",
      tags: { has: "web-development" },
    });
  });

  it("leaves the tag out of the query when the filter is absent", async () => {
    await get("/");

    expect(h.job.findMany.mock.calls[0][0].where).toEqual({});
  });

  it("rejects a tag outside the taxonomy with the accepted list", async () => {
    const res = await get("/?tag=not-a-real-tag");

    // A typo must not look like an empty marketplace.
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Unknown tag/);
    expect(String(res.body.error)).toContain("web-development");
    expect(h.job.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/jobs/saved", () => {
  it("returns the caller's bookmarks as job rows, newest first", async () => {
    h.savedJob.findMany.mockResolvedValue([
      { id: "saved_1", createdAt: new Date(), job: { id: "job_1", title: "A" } },
      { id: "saved_2", createdAt: new Date(), job: { id: "job_2", title: "B" } },
    ]);

    const res = await getAuthed("/saved", CLIENT);

    expect(res.status).toBe(200);
    expect(res.body.map((job: any) => job.id)).toEqual(["job_1", "job_2"]);
    // Scoped to the caller, and the job comes back with its relations so the
    // dashboard can render it like any other row.
    expect(h.savedJob.findMany.mock.calls[0][0]).toMatchObject({
      where: { user: { stellarAddress: CLIENT } },
      orderBy: { createdAt: "desc" },
    });
    expect(h.savedJob.findMany.mock.calls[0][0].include.job.include.milestones).toBe(true);
  });

  it("lists each user's own bookmarks", async () => {
    h.savedJob.findMany.mockResolvedValue([]);

    await getAuthed("/saved", CLIENT);

    expect(h.savedJob.findMany.mock.calls[0][0].where).toEqual({
      user: { stellarAddress: CLIENT },
    });
  });

  it("requires a token", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/saved`);

    expect(res.status).toBe(401);
    expect(h.savedJob.findMany).not.toHaveBeenCalled();
  });

  it("is not mistaken for a job id", async () => {
    h.savedJob.findMany.mockResolvedValue([]);

    await getAuthed("/saved", CLIENT);

    expect(h.job.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/jobs/:id/save", () => {
  it("bookmarks the job for the caller, idempotently", async () => {
    h.savedJob.upsert.mockResolvedValue({ id: "saved_1" });

    const res = await sendWithToken("POST", "/job_1/save", CLIENT);

    expect(res.status).toBe(201);
    // Keyed on (user, job): saving twice updates nothing instead of creating a
    // second row or answering with a conflict.
    expect(h.savedJob.upsert.mock.calls[0][0]).toEqual({
      where: { userId_jobId: { userId: "user_client", jobId: "job_1" } },
      create: { userId: "user_client", jobId: "job_1" },
      update: {},
    });
  });

  it("404s a job that does not exist", async () => {
    h.job.findUnique.mockResolvedValue(null);

    const res = await sendWithToken("POST", "/job_missing/save", CLIENT);

    expect(res.status).toBe(404);
    expect(h.savedJob.upsert).not.toHaveBeenCalled();
  });

  it("404s an authenticated address with no user record", async () => {
    // Authentication still succeeds (the token is valid); it is the save handler
    // that has no row to key the bookmark on.
    h.user.findUnique.mockImplementation(({ select }: { select?: { sessions?: unknown } }) =>
      Promise.resolve(select?.sessions ? { id: "user_client", sessions: [] } : null),
    );

    const res = await sendWithToken("POST", "/job_1/save", CLIENT);

    expect(res.status).toBe(404);
    expect(h.savedJob.upsert).not.toHaveBeenCalled();
  });

  it("requires a token", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/job_1/save`, { method: "POST" });

    expect(res.status).toBe(401);
    expect(h.savedJob.upsert).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/jobs/:id/save", () => {
  it("removes the caller's bookmark", async () => {
    h.savedJob.deleteMany.mockResolvedValue({ count: 1 });

    const res = await sendWithToken("DELETE", "/job_1/save", CLIENT);

    expect(res.status).toBe(204);
    expect(h.savedJob.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user_client", jobId: "job_1" },
    });
  });

  it("is a no-op when nothing was bookmarked", async () => {
    h.savedJob.deleteMany.mockResolvedValue({ count: 0 });

    const res = await sendWithToken("DELETE", "/job_1/save", CLIENT);

    // Unsaving something never saved must not error, or the toggle sticks.
    expect(res.status).toBe(204);
  });
});

describe("POST /api/jobs with tags", () => {
  it("stores the chosen tags on the job", async () => {
    h.job.create.mockResolvedValue({ id: "job_1", tags: ["ui-ux-design"] });

    const res = await post({ ...validJob(), tags: ["ui-ux-design", "brand-design"] });

    expect(res.status).toBe(201);
    expect(h.job.create.mock.calls[0][0].data.tags).toEqual(["ui-ux-design", "brand-design"]);
  });

  it("defaults to no tags when the client sends none", async () => {
    h.job.create.mockResolvedValue({ id: "job_1", tags: [] });

    const res = await post(validJob());

    expect(res.status).toBe(201);
    expect(h.job.create.mock.calls[0][0].data.tags).toEqual([]);
  });

  it("de-duplicates repeated tags", async () => {
    h.job.create.mockResolvedValue({ id: "job_1", tags: ["devops"] });

    await post({ ...validJob(), tags: ["devops", "devops"] });

    expect(h.job.create.mock.calls[0][0].data.tags).toEqual(["devops"]);
  });

  it("refuses a tag outside the taxonomy", async () => {
    const res = await post({ ...validJob(), tags: ["crypto-moon"] });

    expect(res.status).toBe(400);
    expect(h.job.create).not.toHaveBeenCalled();
  });

  it("refuses more tags than a job may carry", async () => {
    const tooMany = SKILL_TAGS.slice(0, 9).map((tag) => tag.slug);

    const res = await post({ ...validJob(), tags: tooMany });

    expect(res.status).toBe(400);
    expect(h.job.create).not.toHaveBeenCalled();
  });
});

/**
 * GET /api/jobs/:id and pending disputes (issue #32).
 *
 * `POST /api/disputes` records an intent and returns unsigned XDR. Until the
 * transaction confirms, that row has `onChainId = null` and is not a dispute:
 * the detail route must filter it out, exactly like `GET /api/disputes/:id`
 * 404s it. The assertion is on the query the route builds, because the stub
 * cannot filter for us.
 */
describe("GET /api/jobs/:id: pending disputes", () => {
  it("asks the database only for disputes that are on-chain", async () => {
    h.job.findUnique.mockResolvedValue({ id: "job_1", disputes: [] });

    const res = await get("/job_1");

    expect(res.status).toBe(200);
    const query = h.job.findUnique.mock.calls[0][0] as {
      include: { disputes: { where: Record<string, unknown> } };
    };
    expect(query.include.disputes.where).toEqual({ onChainId: { not: null } });
  });

  it("serves a job with its confirmed dispute and no pending row", async () => {
    h.job.findUnique.mockResolvedValue({
      id: "job_1",
      disputes: [{ id: "d1", jobId: "job_1", onChainId: "7", status: "RAISED" }],
    });

    const res = await get("/job_1");

    expect(res.status).toBe(200);
    expect(res.body.disputes).toHaveLength(1);
    expect(res.body.disputes[0].onChainId).toBe("7");
  });
});
