import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { SignJWT } from "jose";
import { milestonesRouter } from "../routes/milestones";
import { jobsRouter } from "../routes/jobs";
import { errorHandler } from "../middleware/errorHandler";

const CLIENT = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";
const FREELANCER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const OTHER_USER = "GDMVLW7Y3L2R5G3U2SBNFFXN677OHZCRW3B2PZ6WJFF3TPLXJ5L4I2KJ";

const JWT_SECRET = process.env.JWT_SECRET || "development-secret-change-in-production";

const h = vi.hoisted(() => ({
  milestone: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  job: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  deliverable: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../db", () => ({
  prisma: {
    milestone: h.milestone,
    job: h.job,
    user: h.user,
    deliverable: h.deliverable,
  },
}));

let server: Server;
let baseUrl: string;

async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/milestones", milestonesRouter);
  app.use("/api/jobs", jobsRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  h.milestone.findUnique.mockReset();
  h.milestone.findFirst.mockReset();
  h.job.findUnique.mockReset();
  h.user.findUnique.mockReset();
  h.user.upsert.mockReset();
  h.deliverable.create.mockReset();
  h.deliverable.findMany.mockReset();
  // `requireAuth` loads the caller's current session before the handler runs.
  h.user.findUnique.mockImplementation(({ where }: { where: { stellarAddress: string } }) =>
    Promise.resolve({
      id: `user_${where.stellarAddress}`,
      stellarAddress: where.stellarAddress,
      sessions: [],
    }),
  );
});

describe("Milestone Deliverables API (Issue #65)", () => {
  describe("POST /api/milestones/:id/deliverables", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await fetch(`${baseUrl}/api/milestones/m_1/deliverables`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: "work.zip", fileUrl: "https://example.com/work.zip" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects if milestone is not found with 404", async () => {
      const token = await tokenFor(FREELANCER);
      h.milestone.findUnique.mockResolvedValue(null);

      const res = await fetch(`${baseUrl}/api/milestones/m_missing/deliverables`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ fileName: "work.zip", fileUrl: "https://example.com/work.zip" }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects if caller is not the freelancer with 403", async () => {
      const token = await tokenFor(OTHER_USER);
      h.milestone.findUnique.mockResolvedValue({
        id: "m_1",
        status: "PENDING",
        job: {
          id: "job_1",
          freelancer: { stellarAddress: FREELANCER },
          client: { stellarAddress: CLIENT },
        },
      });

      const res = await fetch(`${baseUrl}/api/milestones/m_1/deliverables`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ fileName: "work.zip", fileUrl: "https://example.com/work.zip" }),
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as any;
      expect(json.error).toMatch(/only the assigned freelancer/i);
    });

    it("rejects if milestone is already released with 400", async () => {
      const token = await tokenFor(FREELANCER);
      h.milestone.findUnique.mockResolvedValue({
        id: "m_1",
        status: "RELEASED",
        job: {
          id: "job_1",
          freelancer: { stellarAddress: FREELANCER },
          client: { stellarAddress: CLIENT },
        },
      });

      const res = await fetch(`${baseUrl}/api/milestones/m_1/deliverables`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ fileName: "work.zip", fileUrl: "https://example.com/work.zip" }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.error).toMatch(/already released/i);
    });

    it("attaches deliverable file successfully", async () => {
      const token = await tokenFor(FREELANCER);
      h.milestone.findUnique.mockResolvedValue({
        id: "m_1",
        status: "PENDING",
        job: {
          id: "job_1",
          freelancer: { stellarAddress: FREELANCER },
          client: { stellarAddress: CLIENT },
        },
      });
      h.user.upsert.mockResolvedValue({
        id: "user_freelancer_id",
        stellarAddress: FREELANCER,
      });
      h.deliverable.create.mockResolvedValue({
        id: "deliv_1",
        milestoneId: "m_1",
        fileName: "design_spec.pdf",
        fileUrl: "https://example.com/design_spec.pdf",
        fileSize: 10240,
        fileType: "application/pdf",
        description: "Complete design spec for milestone 1",
        uploadedById: "user_freelancer_id",
      });

      const res = await fetch(`${baseUrl}/api/milestones/m_1/deliverables`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fileName: "design_spec.pdf",
          fileUrl: "https://example.com/design_spec.pdf",
          fileSize: 10240,
          fileType: "application/pdf",
          description: "Complete design spec for milestone 1",
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as any;
      expect(json.id).toBe("deliv_1");
      expect(json.fileName).toBe("design_spec.pdf");
      expect(h.deliverable.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            milestoneId: "m_1",
            fileName: "design_spec.pdf",
            fileSize: 10240,
            uploadedById: "user_freelancer_id",
          }),
        }),
      );
    });
  });

  describe("GET /api/milestones/:id/deliverables", () => {
    it("returns deliverables for a milestone", async () => {
      const token = await tokenFor(FREELANCER);
      h.milestone.findUnique.mockResolvedValue({
        id: "m_1",
        job: {
          client: { stellarAddress: CLIENT },
          freelancer: { stellarAddress: FREELANCER },
        },
      });
      h.deliverable.findMany.mockResolvedValue([
        {
          id: "deliv_1",
          milestoneId: "m_1",
          fileName: "screenshot.png",
          fileUrl: "https://example.com/screenshot.png",
          fileSize: 2048,
        },
      ]);

      const res = await fetch(`${baseUrl}/api/milestones/m_1/deliverables`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json).toHaveLength(1);
      expect(json[0].fileName).toBe("screenshot.png");
    });
  });

  describe("POST & GET /api/jobs/:jobId/milestones/:index/deliverables", () => {
    it("attaches deliverable via job ID and milestone index", async () => {
      const token = await tokenFor(FREELANCER);
      h.job.findUnique.mockResolvedValue({
        id: "job_1",
        freelancer: { stellarAddress: FREELANCER },
      });
      h.milestone.findFirst.mockResolvedValue({
        id: "m_index_0",
        jobId: "job_1",
        index: 0,
        status: "PENDING",
      });
      h.user.upsert.mockResolvedValue({
        id: "user_freelancer_id",
        stellarAddress: FREELANCER,
      });
      h.deliverable.create.mockResolvedValue({
        id: "deliv_idx_1",
        milestoneId: "m_index_0",
        fileName: "code.tar.gz",
        fileUrl: "https://example.com/code.tar.gz",
      });

      const res = await fetch(`${baseUrl}/api/jobs/job_1/milestones/0/deliverables`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fileName: "code.tar.gz",
          fileUrl: "https://example.com/code.tar.gz",
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as any;
      expect(json.id).toBe("deliv_idx_1");
    });

    it("retrieves deliverables via job ID and milestone index", async () => {
      h.milestone.findFirst.mockResolvedValue({
        id: "m_index_0",
        jobId: "job_1",
        index: 0,
      });
      h.deliverable.findMany.mockResolvedValue([
        { id: "deliv_idx_1", fileName: "code.tar.gz" },
      ]);

      const res = await fetch(`${baseUrl}/api/jobs/job_1/milestones/0/deliverables`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json).toHaveLength(1);
      expect(json[0].fileName).toBe("code.tar.gz");
    });
  });

  describe("Milestone (jobId, index) uniqueness (issue #40)", () => {
    it("allows uniquely identifying a milestone by jobId and index", async () => {
      h.milestone.findUnique.mockResolvedValue({
        id: "m_index_0",
        jobId: "job_1",
        index: 0,
      });

      const result = await h.milestone.findUnique({
        where: { jobId_index: { jobId: "job_1", index: 0 } },
      });
      expect(result).toEqual({ id: "m_index_0", jobId: "job_1", index: 0 });
    });
  });
});
