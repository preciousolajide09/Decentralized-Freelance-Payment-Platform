import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { SignJWT } from "jose";

const JWT_SECRET = "test-secret-at-least-32-chars-long-for-tests";
process.env.JWT_SECRET = JWT_SECRET;
process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";

interface FakeUser {
  id: string;
  stellarAddress: string;
}

interface FakeNotification {
  id: string;
  userId: string;
  jobId: string | null;
  type: "FUNDED" | "RELEASED" | "DISPUTED" | "RESOLVED";
  title: string;
  message: string;
  read: boolean;
  createdAt: Date;
}

const fakeUsers: FakeUser[] = [];
const fakeNotifications: FakeNotification[] = [];

vi.mock("../db", () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { stellarAddress?: string; id?: string } }) => {
          if (where.stellarAddress) {
            const user = fakeUsers.find((u) => u.stellarAddress === where.stellarAddress);
            // `requireAuth` reads the current session alongside the user row.
            return user ? { ...user, sessions: [] } : null;
          }
          if (where.id) {
            const user = fakeUsers.find((u) => u.id === where.id);
            return user ? { ...user, sessions: [] } : null;
          }
          return null;
        }),
      },
      notification: {
        findMany: vi.fn(async ({ where }: { where: { userId: string; read?: boolean } }) => {
          return fakeNotifications.filter((n) => {
            if (n.userId !== where.userId) return false;
            if (where.read !== undefined && n.read !== where.read) return false;
            return true;
          });
        }),
        count: vi.fn(async ({ where }: { where: { userId: string; read?: boolean } }) => {
          return fakeNotifications.filter((n) => {
            if (n.userId !== where.userId) return false;
            if (where.read !== undefined && n.read !== where.read) return false;
            return true;
          }).length;
        }),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          return fakeNotifications.find((n) => n.id === where.id) ?? null;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { read: boolean } }) => {
          const notif = fakeNotifications.find((n) => n.id === where.id);
          if (notif) notif.read = data.read;
          return notif;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: { userId: string; read?: boolean }; data: { read: boolean } }) => {
          let count = 0;
          for (const n of fakeNotifications) {
            if (n.userId === where.userId && (where.read === undefined || n.read === where.read)) {
              n.read = data.read;
              count++;
            }
          }
          return { count };
        }),
        create: vi.fn(async ({ data }: { data: Omit<FakeNotification, "id" | "createdAt" | "read"> }) => {
          const notif: FakeNotification = {
            id: `notif-${fakeNotifications.length + 1}`,
            read: false,
            createdAt: new Date(),
            ...data,
          };
          fakeNotifications.push(notif);
          return notif;
        }),
      },
      job: {
        findUnique: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({})),
      },
      dispute: {
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    },
  };
});

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { notificationsRouter } = await import("../routes/notifications");
  const { errorHandler } = await import("../middleware/errorHandler");

  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationsRouter);
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
  fakeUsers.length = 0;
  fakeNotifications.length = 0;
});

async function makeToken(address: string): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
}

describe("Notifications API (#66)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${baseUrl}/api/notifications`);
    expect(res.status).toBe(401);
  });

  it("returns notifications and unreadCount for the authenticated user", async () => {
    const user: FakeUser = {
      id: "u1",
      stellarAddress: "GBTESTUSER11111111111111111111111111111111111111111111111",
    };
    fakeUsers.push(user);
    fakeNotifications.push({
      id: "n1",
      userId: "u1",
      jobId: "job-1",
      type: "FUNDED",
      title: "Escrow Funded",
      message: "Escrow has been funded.",
      read: false,
      createdAt: new Date(),
    });
    fakeNotifications.push({
      id: "n2",
      userId: "u1",
      jobId: "job-1",
      type: "RELEASED",
      title: "Milestone Released",
      message: "Milestone 1 released.",
      read: true,
      createdAt: new Date(),
    });
    // Another user's notification should not leak
    fakeNotifications.push({
      id: "n3",
      userId: "u2",
      jobId: "job-2",
      type: "DISPUTED",
      title: "Dispute Opened",
      message: "Dispute opened.",
      read: false,
      createdAt: new Date(),
    });

    const token = await makeToken(user.stellarAddress);
    const res = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: FakeNotification[];
      unreadCount: number;
    };
    expect(body.notifications).toHaveLength(2);
    expect(body.unreadCount).toBe(1);
    expect(body.notifications[0]?.title).toBe("Escrow Funded");
  });

  it("marks a single notification as read", async () => {
    const user: FakeUser = {
      id: "u1",
      stellarAddress: "GBTESTUSER11111111111111111111111111111111111111111111111",
    };
    fakeUsers.push(user);
    fakeNotifications.push({
      id: "n1",
      userId: "u1",
      jobId: "job-1",
      type: "DISPUTED",
      title: "Dispute Opened",
      message: "Dispute opened.",
      read: false,
      createdAt: new Date(),
    });

    const token = await makeToken(user.stellarAddress);
    const res = await fetch(`${baseUrl}/api/notifications/n1/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FakeNotification;
    expect(body.read).toBe(true);
    expect(fakeNotifications[0]?.read).toBe(true);
  });

  it("rejects marking another user's notification as read with 404", async () => {
    const user: FakeUser = {
      id: "u1",
      stellarAddress: "GBTESTUSER11111111111111111111111111111111111111111111111",
    };
    fakeUsers.push(user);
    fakeNotifications.push({
      id: "n2",
      userId: "u2", // belongs to u2
      jobId: "job-1",
      type: "RESOLVED",
      title: "Dispute Resolved",
      message: "Resolved.",
      read: false,
      createdAt: new Date(),
    });

    const token = await makeToken(user.stellarAddress);
    const res = await fetch(`${baseUrl}/api/notifications/n2/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("marks all notifications as read for the user", async () => {
    const user: FakeUser = {
      id: "u1",
      stellarAddress: "GBTESTUSER11111111111111111111111111111111111111111111111",
    };
    fakeUsers.push(user);
    fakeNotifications.push(
      {
        id: "n1",
        userId: "u1",
        jobId: "j1",
        type: "FUNDED",
        title: "T1",
        message: "M1",
        read: false,
        createdAt: new Date(),
      },
      {
        id: "n2",
        userId: "u1",
        jobId: "j2",
        type: "RESOLVED",
        title: "T2",
        message: "M2",
        read: false,
        createdAt: new Date(),
      },
    );

    const token = await makeToken(user.stellarAddress);
    const res = await fetch(`${baseUrl}/api/notifications/read-all`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(fakeNotifications.every((n) => n.read)).toBe(true);
  });
});
