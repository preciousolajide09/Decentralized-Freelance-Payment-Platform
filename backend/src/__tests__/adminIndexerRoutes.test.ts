import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { SignJWT } from "jose";

const h = vi.hoisted(() => ({
  secret: "test-admin-indexer-secret-at-least-32-characters",
  admin: "GADMIN",
  findUnique: vi.fn(),
  findMany: vi.fn(),
  delete: vi.fn(),
  restore: vi.fn(),
  dispatch: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../config", () => ({
  config: {
    JWT_SECRET: h.secret,
    INDEXER_ADMIN_ADDRESSES: h.admin,
  },
}));

vi.mock("../db", () => ({
  prisma: {
    indexerDeadLetter: {
      findUnique: h.findUnique,
      findMany: h.findMany,
      delete: h.delete,
    },
    // `requireAuth` loads the caller's current session before the admin guard.
    user: { findUnique: h.userFindUnique },
  },
}));

vi.mock("../indexer", () => ({
  dispatchEvent: h.dispatch,
  restoreDeadLetterEvent: h.restore,
}));

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { adminIndexerRouter } = await import("../routes/adminIndexer");
  const { errorHandler } = await import("../middleware/errorHandler");
  const app = express();
  app.use("/api/admin/indexer", adminIndexerRouter);
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
  h.findUnique.mockReset();
  h.findMany.mockReset();
  h.delete.mockReset();
  h.restore.mockReset();
  h.dispatch.mockReset();
  h.userFindUnique.mockReset();
  h.userFindUnique.mockResolvedValue({ id: "auth_user", sessions: [] });
});

async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(h.secret));
}

async function post(path: string, address: string) {
  const res = await fetch(`${baseUrl}/api/admin/indexer${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenFor(address)}` },
  });
  return { status: res.status, body: await res.json() };
}

describe("admin indexer replay routes", () => {
  it("dispatches a selected dead letter before deleting it", async () => {
    const event = { id: "evt-1" };
    h.findUnique.mockResolvedValue({ id: "evt-1", eventPayload: { id: "evt-1" } });
    h.restore.mockReturnValue(event);
    h.dispatch.mockResolvedValue(undefined);
    h.delete.mockResolvedValue({ id: "evt-1" });

    const res = await post("/replay/evt-1", h.admin);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ replayed: 1, id: "evt-1" });
    expect(h.dispatch).toHaveBeenCalledWith(event);
    expect(h.delete).toHaveBeenCalledWith({ where: { id: "evt-1" } });
  });

  it("keeps the dead letter when dispatch fails", async () => {
    h.findUnique.mockResolvedValue({ id: "evt-1", eventPayload: { id: "evt-1" } });
    h.restore.mockReturnValue({ id: "evt-1" });
    h.dispatch.mockRejectedValue(new Error("handler failed"));

    const res = await post("/replay/evt-1", h.admin);

    expect(res.status).toBe(500);
    expect(h.delete).not.toHaveBeenCalled();
  });

  it("reports per-event results when replaying all dead letters", async () => {
    h.findMany.mockResolvedValue([
      { id: "evt-ok", eventPayload: { id: "evt-ok" } },
      { id: "evt-fail", eventPayload: { id: "evt-fail" } },
    ]);
    h.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      eventPayload: { id: where.id },
    }));
    h.restore.mockImplementation((payload: { id: string }) => ({ id: payload.id }));
    h.dispatch.mockImplementation(async (event: { id: string }) => {
      if (event.id === "evt-fail") throw new Error("handler failed");
    });

    const res = await post("/replay-all", h.admin);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      replayed: 1,
      failed: [{ id: "evt-fail", error: "handler failed" }],
    });
    expect(h.delete).toHaveBeenCalledTimes(1);
    expect(h.delete).toHaveBeenCalledWith({ where: { id: "evt-ok" } });
  });

  it("does not allow a non-admin to inspect or replay dead letters", async () => {
    const res = await post("/replay-all", "GOTHER");

    expect(res.status).toBe(403);
    expect(h.findMany).not.toHaveBeenCalled();
  });
});
