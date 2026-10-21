/**
 * jobs.ts
 *
 * GET  /api/jobs                   — list jobs (filterable by status, client, freelancer, tag)
 * GET  /api/jobs/tags              — the curated skill-tag list
 * GET  /api/jobs/by-escrow/:escrowId — lookup job by on-chain escrow ID (issue #173)
 * GET  /api/jobs/saved             — the caller's bookmarked jobs
 * POST /api/jobs/:id/save          — bookmark a job
 * DELETE /api/jobs/:id/save        — remove a bookmark
 * POST /api/jobs                   — create a job (off-chain record; escrow funded separately)
 * GET  /api/jobs/:id               — get single job with milestones
 * PUT  /api/jobs/:id/assign        — client assigns a freelancer
 *
 * Route order matters: the literal paths (`/tags`, `/by-escrow`, `/saved`) are registered
 * before `/:id`, or they would be read as job ids.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import {
  formatAmount,
  getAsset,
  sumAmounts,
  toBaseUnits,
  UnknownAssetError,
  type AssetInfo,
} from "../lib/assets";
import {
  createJobSchema,
  createProposalSchema,
  createDeliverableSchema,
  assignJobSchema,
  listJobsQuerySchema,
} from "../lib/schemas";
import { isSkillTag, SKILL_TAGS, SKILL_TAG_SLUGS } from "../lib/tags";

export const jobsRouter = Router();

// GET /api/jobs
//
// The query string is parsed with `listJobsQuerySchema` before it reaches
// Prisma: an unknown `status` used to throw inside Prisma (a 500 rather than a
// 400), a non-numeric `page`/`limit` became `NaN` in `skip`/`take`, and `limit`
// was unbounded.
jobsRouter.get("/", async (req, res, next) => {
  try {
    const parsed = listJobsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join(", "));
    }
    const { status, client, freelancer, tag, q, sort, page, limit } = parsed.data;

    // A tag the taxonomy does not know is a caller mistake, not "no results" —
    // answering 400 with the accepted slugs keeps a typo from looking like an
    // empty marketplace.
    let tagFilter: string | undefined;
    if (tag !== undefined) {
      const value = String(tag);
      if (!isSkillTag(value)) {
        throw new AppError(400, `Unknown tag "${value}". Accepted tags: ${SKILL_TAG_SLUGS.join(", ")}`);
      }
      tagFilter = value;
    }

    // Keyword search (issue #62): one case-insensitive substring match across
    // the two human-readable fields. Empty/whitespace `q` means "no filter".
    const searchFilter = q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { description: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {};

    // Sort (issue #62). The default stays newest-first, matching the index on
    // (status, createdAt); an unrecognised value is rejected by the schema.
    const orderBy =
      sort === "oldest"
        ? { createdAt: "asc" as const }
        : sort === "amount_desc"
          ? { totalAmount: "desc" as const }
          : sort === "amount_asc"
            ? { totalAmount: "asc" as const }
            : { createdAt: "desc" as const };

    const jobs = await prisma.job.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(client ? { client: { stellarAddress: client } } : {}),
        ...(freelancer ? { freelancer: { stellarAddress: freelancer } } : {}),
        // Postgres array containment: a job matches when its tags include this one.
        ...(tagFilter ? { tags: { has: tagFilter } } : {}),
        ...searchFilter,
      },
      include: { milestones: true, client: true, freelancer: true },
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    });
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/tags — the curated taxonomy, so a client can render the picker
// and the filter without duplicating the list (issue #70).
jobsRouter.get("/tags", (_req, res) => {
  res.json(SKILL_TAGS);
});

// GET /api/jobs/by-escrow/:escrowId — direct lookup by on-chain escrow ID.
//
// Frontend pages route by the on-chain escrowId, while most backend API routes
// require the off-chain job.id. This endpoint eliminates expensive multi-page
// scans when searching for a job by its escrow (issue #173).
jobsRouter.get("/by-escrow/:escrowId", async (req, res, next) => {
  try {
    const escrowIdStr = req.params.escrowId;
    
    // Parse the escrow ID as a BigInt. Allow both string and number formats.
    let escrowId: bigint;
    try {
      escrowId = BigInt(escrowIdStr);
    } catch {
      throw new AppError(400, "Invalid escrow ID format");
    }

    const job = await prisma.job.findUnique({
      where: { escrowId },
      include: { milestones: true, client: true, freelancer: true },
    });
    
    if (!job) throw new AppError(404, "Job not found");
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/saved — the caller's bookmarks, most recently saved first.
//
// Returns job rows (not bookmark rows) so the client can render them with the
// same list component it uses for `GET /api/jobs` (issue #71).
jobsRouter.get("/saved", requireAuth, async (_req, res, next) => {
  try {
    const saved = await prisma.savedJob.findMany({
      where: { user: { stellarAddress: res.locals.stellarAddress } },
      orderBy: { createdAt: "desc" },
      include: { job: { include: { milestones: true, client: true, freelancer: true } } },
    });
    res.json(saved.map((entry) => entry.job));
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/save
//
// Idempotent: `upsert` on the (user, job) key, so a double click leaves one
// bookmark rather than a 409 the UI has to interpret.
jobsRouter.post("/:id/save", requireAuth, async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!job) throw new AppError(404, "Job not found");

    const user = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
      select: { id: true },
    });
    if (!user) throw new AppError(404, "User not found — call /api/users/auth first");

    const saved = await prisma.savedJob.upsert({
      where: { userId_jobId: { userId: user.id, jobId: job.id } },
      create: { userId: user.id, jobId: job.id },
      update: {},
    });
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/jobs/:id/save — unsaving something that was never saved is a
// no-op, not an error, so the toggle always settles.
jobsRouter.delete("/:id/save", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
      select: { id: true },
    });
    if (!user) throw new AppError(404, "User not found — call /api/users/auth first");

    await prisma.savedJob.deleteMany({ where: { userId: user.id, jobId: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs
jobsRouter.post("/", requireAuth, validate(createJobSchema), async (req, res, next) => {
  try {
    const { title, description, milestones, expiresAt, asset, tags } = req.body as z.infer<
      typeof createJobSchema
    >;

    let assetInfo: AssetInfo;
    try {
      assetInfo = getAsset(asset);
    } catch (err) {
      if (err instanceof UnknownAssetError) throw new AppError(400, err.message);
      throw err;
    }

    const client = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
    });
    if (!client) throw new AppError(404, "User not found — call /api/users/auth first");

    // Sum in the asset's integer base units and format once. Adding whole-unit
    // decimals as JavaScript numbers carries float error into the DECIMAL(65,30)
    // column: two `0.1` milestones became `0.30000000000000004`, which is what
    // GET /api/jobs then returned and the dashboard displayed.
    const totalAmount = formatAmount(
      sumAmounts(milestones.map((m) => m.amount), assetInfo.decimals),
      assetInfo.decimals,
    );

    const job = await prisma.job.create({
      data: {
        title,
        description,
        asset: assetInfo.symbol,
        tags,
        totalAmount,
        clientId: client.id,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        milestones: {
          create: milestones.map((m, i) => ({
            index: i,
            // Store each amount at the asset's own precision so the milestones
            // and the total are consistent with the on-chain base units.
            amount: formatAmount(
              toBaseUnits(m.amount, assetInfo.decimals),
              assetInfo.decimals,
            ),
            description: m.description,
            deadline: m.deadline ? new Date(m.deadline) : undefined,
          })),
        },
      },
      include: { milestones: true },
    });

    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id
jobsRouter.get("/:id", async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: {
        milestones: {
          include: {
            deliverables: {
              include: { uploadedBy: true },
              orderBy: { createdAt: "desc" },
            },
          },
          orderBy: { index: "asc" },
        },
        client: true,
        freelancer: true,
        // PENDING rows are intents whose transaction was built but not confirmed;
        // they must not appear on a job either (#32).
        disputes: { where: { onChainId: { not: null } }, orderBy: { createdAt: "asc" } },
        ratings: true,
        proposals: { include: { freelancer: true }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!job) throw new AppError(404, "Job not found");
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/proposals
jobsRouter.post("/:id/proposals", requireAuth, validate(createProposalSchema), async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: { client: true },
    });
    if (!job) throw new AppError(404, "Job not found");

    if (job.client.stellarAddress === res.locals.stellarAddress) {
      throw new AppError(400, "Client cannot apply to their own job");
    }

    if (job.freelancerId || job.status !== "CREATED") {
      throw new AppError(400, "Job is not open for proposals");
    }

    const freelancer = await prisma.user.upsert({
      where: { stellarAddress: res.locals.stellarAddress },
      create: { stellarAddress: res.locals.stellarAddress },
      update: {},
    });

    const { coverLetter, proposedRate } = req.body as {
      coverLetter?: string;
      proposedRate?: string | number;
    };

    try {
      const proposal = await prisma.proposal.create({
        data: {
          jobId: job.id,
          freelancerId: freelancer.id,
          coverLetter,
          proposedRate: proposedRate !== undefined ? String(proposedRate) : undefined,
        },
        include: { freelancer: true },
      });
      res.status(201).json(proposal);
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new AppError(409, "You have already applied for this job");
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/proposals
jobsRouter.get("/:id/proposals", async (req, res, next) => {
  try {
    const proposals = await prisma.proposal.findMany({
      where: { jobId: req.params.id },
      include: { freelancer: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(proposals);
  } catch (err) {
    next(err);
  }
});

// PUT /api/jobs/:id/assign
jobsRouter.put("/:id/assign", requireAuth, validate(assignJobSchema), async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id }, include: { client: true } });
    if (!job) throw new AppError(404, "Job not found");
    if (job.client.stellarAddress !== res.locals.stellarAddress) {
      throw new AppError(403, "Only the client can assign a freelancer");
    }

    if (job.freelancerId) {
      throw new AppError(400, "Job is already assigned to a freelancer");
    }

    const { freelancerAddress } = req.body as z.infer<typeof assignJobSchema>;
    if (job.client.stellarAddress === freelancerAddress) {
      throw new AppError(400, "Client cannot be assigned as freelancer to their own job");
    }

    const freelancer = await prisma.user.findUnique({ where: { stellarAddress: freelancerAddress } });
    if (!freelancer) throw new AppError(404, "Freelancer not found");

    const updated = await prisma.job.update({
      where: { id: req.params.id },
      data: { freelancerId: freelancer.id },
    });

    // Accept selected proposal and reject other pending proposals
    await prisma.proposal.updateMany({
      where: { jobId: job.id, freelancerId: freelancer.id },
      data: { status: "ACCEPTED" },
    });
    await prisma.proposal.updateMany({
      where: { jobId: job.id, freelancerId: { not: freelancer.id }, status: "PENDING" },
      data: { status: "REJECTED" },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:jobId/milestones/:index/deliverables
jobsRouter.post(
  "/:jobId/milestones/:index/deliverables",
  requireAuth,
  validate(createDeliverableSchema),
  async (req, res, next) => {
    try {
      const milestoneIndex = parseInt(req.params.index, 10);
      if (isNaN(milestoneIndex)) throw new AppError(400, "Invalid milestone index");

      const job = await prisma.job.findUnique({
        where: { id: req.params.jobId },
        include: { freelancer: true },
      });
      if (!job) throw new AppError(404, "Job not found");

      if (job.freelancer?.stellarAddress !== res.locals.stellarAddress) {
        throw new AppError(403, "Only the assigned freelancer can attach deliverables to this milestone");
      }

      const milestone = await prisma.milestone.findFirst({
        where: { jobId: job.id, index: milestoneIndex },
      });
      if (!milestone) throw new AppError(404, "Milestone not found");

      if (milestone.status === "RELEASED") {
        throw new AppError(400, "Cannot attach deliverables to an already released milestone");
      }

      const user = await prisma.user.upsert({
        where: { stellarAddress: res.locals.stellarAddress },
        create: { stellarAddress: res.locals.stellarAddress },
        update: {},
      });

      const { fileName, fileUrl, fileSize, fileType, description } = req.body as {
        fileName: string;
        fileUrl: string;
        fileSize?: number;
        fileType?: string;
        description?: string;
      };

      const deliverable = await prisma.deliverable.create({
        data: {
          milestoneId: milestone.id,
          fileName,
          fileUrl,
          fileSize,
          fileType,
          description,
          uploadedById: user.id,
        },
        include: { uploadedBy: true },
      });

      res.status(201).json(deliverable);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/jobs/:jobId/milestones/:index/deliverables
jobsRouter.get("/:jobId/milestones/:index/deliverables", async (req, res, next) => {
  try {
    const milestoneIndex = parseInt(req.params.index, 10);
    if (isNaN(milestoneIndex)) throw new AppError(400, "Invalid milestone index");

    const milestone = await prisma.milestone.findFirst({
      where: { jobId: req.params.jobId, index: milestoneIndex },
    });
    if (!milestone) throw new AppError(404, "Milestone not found");

    const deliverables = await prisma.deliverable.findMany({
      where: { milestoneId: milestone.id },
      include: { uploadedBy: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(deliverables);
  } catch (err) {
    next(err);
  }
});
