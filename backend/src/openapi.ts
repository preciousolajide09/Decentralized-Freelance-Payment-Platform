/**
 * openapi.ts
 *
 * The machine-readable HTTP API description (OpenAPI 3.0), generated from the
 * same Zod schemas the routes validate with, so the spec and the validation
 * cannot drift (issue #61).
 *
 * The request bodies come straight from the route modules — `createJobSchema`
 * from `lib/schemas.ts`, and the per-route schemas that `routes/*.ts` now
 * export. A Zod schema is used in two places at once: `validate()` rejects a
 * bad request with it, and this file renders it into the document. Response
 * bodies are described here by hand, because the rows they return come from
 * Prisma models rather than Zod.
 *
 * `docsEnabled` guards mounting: the routes are served at `/api/docs` outside
 * production, so an unauthenticated API-explorer page is never exposed on a
 * deployed instance.
 *
 * Contributor notes:
 * - Adding a route means adding a `registry.registerPath` entry here; the
 *   `__tests__/openapi.test.ts` check fails if a router path is missing.
 * - Prisma `BigInt` ids (`escrowId`, `onChainId`) serialize as strings (see
 *   `lib/json.ts`), so they are typed as strings here.
 */

import { z, type ZodTypeAny } from "zod";
import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

import { config } from "./config";
import {
  createDeliverableSchema,
  createJobSchema,
  createProposalSchema,
  transactionHistoryQuerySchema,
} from "./lib/schemas";
import { authSchema, updateSchema } from "./routes/users";
import {
  buildCreateSchema,
  recordMilestonesSchema,
  releaseSchema,
  syncSchema as escrowSyncSchema,
  updateMilestonesSchema,
} from "./routes/escrow";
import {
  raiseSchema,
  resolveSchema,
  syncSchema as disputeSyncSchema,
} from "./routes/disputes";
import { submitSchema } from "./routes/reputation";
import { sendMessageSchema } from "./routes/messages";

// Patches `z` so schemas can be annotated/registered. Called once, before any
// schema below is registered.
extendZodWithOpenApi(z);

/** Serve `/api/docs` in development and test, but never in production. */
export const docsEnabled = config.NODE_ENV !== "production";

const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description:
    "JWT issued by POST /api/users/auth after the wallet signs a challenge nonce.",
});

// ---------------------------------------------------------------------------
// Component schemas
// ---------------------------------------------------------------------------

const jobStatus = z.enum(["CREATED", "FUNDED", "ACTIVE", "COMPLETED", "DISPUTED", "REFUNDED"]);
const milestoneStatus = z.enum(["PENDING", "RELEASED"]);
const disputeStatus = z.enum([
  "PENDING",
  "RAISED",
  "UNDER_REVIEW",
  "RESOLVED",
  "REFUNDED",
]);

const publicUser = registry.register(
  "User",
  z.object({
    id: z.string(),
    stellarAddress: z.string().describe("Stellar account (G…)"),
    displayName: z.string().nullable(),
    bio: z.string().nullable(),
    createdAt: z.string().datetime(),
  }),
);

const milestone = registry.register(
  "Milestone",
  z.object({
    id: z.string(),
    jobId: z.string(),
    index: z.number().int().describe("Zero-based position in the job's breakdown"),
    amount: z.string().describe("Whole units of the job's asset, at its precision"),
    description: z.string().nullable(),
    status: milestoneStatus,
    deadline: z.string().datetime().nullable(),
    releasedAt: z.string().datetime().nullable(),
  }),
);

const job = registry.register(
  "Job",
  z.object({
    id: z.string(),
    escrowId: z.string().nullable().describe("On-chain escrow id, once funded"),
    title: z.string(),
    description: z.string(),
    status: jobStatus,
    asset: z.string().describe("Asset symbol the job pays in (e.g. XLM)"),
    clientId: z.string(),
    freelancerId: z.string().nullable(),
    totalAmount: z
      .string()
      .describe("Sum of the milestones, in whole units of `asset` — not USDC"),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    milestones: z.array(milestone).optional(),
    client: publicUser.optional(),
    freelancer: publicUser.nullable().optional(),
  }),
);

const dispute = registry.register(
  "Dispute",
  z.object({
    id: z.string(),
    jobId: z.string(),
    onChainId: z.string().nullable(),
    raisedByAddress: z.string(),
    reason: z.string(),
    status: disputeStatus,
    clientShare: z.string().nullable(),
    freelancerShare: z.string().nullable(),
    createdAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
  }),
);

const rating = registry.register(
  "Rating",
  z.object({
    id: z.string(),
    jobId: z.string(),
    score: z.number().int().min(1).max(5),
    comment: z.string().nullable(),
    createdAt: z.string().datetime(),
  }),
);

const message = registry.register(
  "Message",
  z.object({
    id: z.string(),
    jobId: z.string(),
    senderId: z.string(),
    body: z.string(),
    createdAt: z.string().datetime(),
    readAt: z.string().datetime().nullable().describe("When the recipient read it; null = unread"),
  }),
);

/** A message as the conversation view returns it: with its sender's address. */
const conversationMessage = registry.register(
  "ConversationMessage",
  message.extend({
    sender: z.object({ stellarAddress: z.string(), displayName: z.string().nullable() }),
  }),
);

/** Every `POST /build/*` route answers with an unsigned transaction. */
const unsignedTransaction = registry.register(
  "UnsignedTransaction",
  z.object({
    xdr: z.string().describe("Assembled, unsigned transaction XDR — sign it in the wallet"),
  }),
);

export const apiError = registry.register(
  "ApiError",
  z.object({ error: z.string() }),
);

const jobListQuery = z.object({
  status: jobStatus.optional(),
  client: z.string().optional().describe("Filter by client Stellar address"),
  freelancer: z.string().optional().describe("Filter by freelancer Stellar address"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(20),
});

/** A `{ xdr }` response shared by every transaction-building route. */
const json = (schema: ZodTypeAny, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const errors = {
  400: { description: "The request was rejected (validation or a mapped contract error)" },
  401: { description: "Missing, invalid or expired bearer token" },
  403: { description: "The caller is authenticated but not allowed to do this" },
  404: { description: "The referenced job, dispute or user does not exist" },
  409: { description: "The resource is not in a state that allows this action yet" },
};

const auth = [{ bearerAuth: [] }];

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Liveness probe",
  responses: { 200: json(z.object({ status: z.string() }), "The service is up") },
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/api/users/challenge",
  tags: ["Users"],
  summary: "Issue a single-use nonce for SEP-53 signing",
  request: { query: z.object({ address: z.string().describe("Stellar account (G…)") }) },
  responses: {
    200: json(z.object({ nonce: z.string() }), "The nonce, valid for 60 seconds"),
    400: errors[400],
  },
});

registry.registerPath({
  method: "post",
  path: "/api/users/auth",
  tags: ["Users"],
  summary: "Verify a signed challenge and return a JWT",
  request: { body: { content: { "application/json": { schema: authSchema } } } },
  responses: {
    200: json(z.object({ token: z.string(), user: publicUser }), "Authenticated"),
    401: errors[401],
  },
});

registry.registerPath({
  method: "get",
  path: "/api/users/{address}",
  tags: ["Users"],
  summary: "Get a public profile",
  request: { params: z.object({ address: z.string() }) },
  responses: { 200: json(publicUser, "The user"), 404: errors[404] },
});

registry.registerPath({
  method: "get",
  path: "/api/users/me",
  tags: ["Users"],
  summary: "Get your own profile",
  security: auth,
  responses: { 200: json(publicUser, "The authenticated user"), 401: errors[401] },
});

registry.registerPath({
  method: "post",
  path: "/api/users/logout",
  tags: ["Users"],
  summary: "Revoke the current session",
  description:
    "Increments the user's session token version, invalidating every token issued before this call.",
  security: auth,
  responses: {
    200: json(z.object({ message: z.string() }), "The session was revoked"),
    401: errors[401],
    404: errors[404],
  },
});

registry.registerPath({
  method: "put",
  path: "/api/users/me",
  tags: ["Users"],
  summary: "Update your own profile",
  security: auth,
  request: { body: { content: { "application/json": { schema: updateSchema } } } },
  responses: {
    200: json(publicUser, "The updated user"),
    400: errors[400],
    401: errors[401],
    404: errors[404],
  },
});

const freelancerProfile = z.object({
  id: z.string(),
  stellarAddress: z.string(),
  displayName: z.string().nullable(),
  bio: z.string().nullable(),
  createdAt: z.date().or(z.string()),
  averageScore: z.number(),
  totalRatings: z.number().int(),
  completedJobsCount: z.number().int(),
  totalJobsCount: z.number().int(),
});

registry.registerPath({
  method: "get",
  path: "/api/users/freelancers",
  tags: ["Users"],
  summary: "Browse freelancers directory",
  responses: {
    200: json(
      z.object({
        freelancers: z.array(freelancerProfile),
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
        totalPages: z.number().int(),
      }),
      "Directory page",
    ),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/users",
  tags: ["Users"],
  summary: "Browse freelancers directory (alias)",
  responses: {
    200: json(
      z.object({
        freelancers: z.array(freelancerProfile),
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
        totalPages: z.number().int(),
      }),
      "Directory page",
    ),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/users/{address}/transactions",
  tags: ["Users"],
  summary: "On-chain history for the user's escrows",
  request: {
    params: z.object({ address: z.string() }),
    query: transactionHistoryQuerySchema,
  },
  responses: {
    200: json(
      z.object({
        data: z.array(
          z.object({
            id: z.string(),
            escrowId: z.string(),
            action: z.string(),
            amount: z.string().nullable(),
            asset: z.string().nullable(),
            txHash: z.string().nullable(),
            ledger: z.number().int(),
            createdAt: z.string().datetime(),
          }),
        ),
        pagination: z.object({
          page: z.number().int(),
          limit: z.number().int(),
          total: z.number().int(),
          totalPages: z.number().int(),
        }),
      }),
      "Paginated transaction history",
    ),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/users/{address}/reminders",
  tags: ["Users"],
  summary: "Milestones that are due soon or overdue",
  request: {
    params: z.object({ address: z.string() }),
    query: z.object({ withinHours: z.coerce.number().optional() }),
  },
  responses: {
    200: json(
      z.array(
        z.object({
          jobId: z.string(),
          title: z.string(),
          escrowId: z.string().nullable(),
          milestoneIndex: z.number().int(),
          description: z.string().nullable(),
          amount: z.string(),
          deadline: z.string(),
          kind: z.enum(["overdue", "due-soon"]),
          role: z.enum(["client", "freelancer"]),
        }),
      ),
      "Milestone reminders",
    ),
  },
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/api/jobs",
  tags: ["Jobs"],
  summary: "List jobs with status filters and pagination",
  request: { query: jobListQuery },
  responses: { 200: json(z.array(job), "A page of jobs, newest first") },
});

registry.registerPath({
  method: "post",
  path: "/api/jobs",
  tags: ["Jobs"],
  summary: "Create the off-chain job record",
  description:
    "Stores the metadata; the escrow itself is created on-chain with POST /api/escrow/build/create.",
  security: auth,
  request: { body: { content: { "application/json": { schema: createJobSchema } } } },
  responses: {
    201: json(job, "The created job"),
    400: errors[400],
    401: errors[401],
    404: errors[404],
  },
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/by-escrow/{escrowId}",
  tags: ["Jobs"],
  summary: "Get a job by its on-chain escrow id",
  description:
    "Looks up the off-chain job whose `escrowId` matches, without paging through the job list.",
  request: {
    params: z.object({ escrowId: z.string().describe("On-chain escrow id (u64 as a decimal string)") }),
  },
  responses: {
    200: json(job, "The job, with its milestones, client and freelancer"),
    400: errors[400],
    404: errors[404],
  },
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/{id}",
  tags: ["Jobs"],
  summary: "Get a job with its milestones, dispute and ratings",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: json(
      job.extend({ disputes: z.array(dispute), ratings: z.array(rating) }),
      "The job",
    ),
    404: errors[404],
  },
});

const proposal = z.object({
  id: z.string(),
  jobId: z.string(),
  freelancerId: z.string(),
  coverLetter: z.string().nullable(),
  proposedRate: z.string().nullable(),
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED"]),
  createdAt: z.date().or(z.string()),
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/{id}/proposals",
  tags: ["Jobs"],
  summary: "List the proposals submitted for a job",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: json(z.array(proposal), "The job's proposals") },
});

registry.registerPath({
  method: "post",
  path: "/api/jobs/{id}/proposals",
  tags: ["Jobs"],
  summary: "Apply to an open job",
  security: auth,
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: createProposalSchema } } },
  },
  responses: {
    201: json(proposal, "The submitted proposal"),
    400: errors[400],
    401: errors[401],
    404: errors[404],
  },
});

registry.registerPath({
  method: "post",
  path: "/api/jobs/{jobId}/milestones/{index}/deliverables",
  tags: ["Jobs"],
  summary: "Attach a deliverable to a milestone (assigned freelancer only)",
  security: auth,
  request: {
    params: z.object({ jobId: z.string(), index: z.coerce.number().int() }),
    body: { content: { "application/json": { schema: createDeliverableSchema } } },
  },
  responses: { 201: json(z.object({ id: z.string() }), "The deliverable"), 400: errors[400] },
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/{jobId}/milestones/{index}/deliverables",
  tags: ["Jobs"],
  summary: "List a milestone's deliverables",
  request: { params: z.object({ jobId: z.string(), index: z.coerce.number().int() }) },
  responses: { 200: json(z.array(z.object({ id: z.string() })), "The deliverables") },
});

registry.registerPath({
  method: "put",
  path: "/api/jobs/{id}/assign",
  tags: ["Jobs"],
  summary: "Assign a freelancer to a job (client only)",
  security: auth,
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ freelancerAddress: z.string() }) } } },
  },
  responses: {
    200: json(job, "The updated job"),
    401: errors[401],
    403: errors[403],
    404: errors[404],
  },
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/tags",
  tags: ["Jobs"],
  summary: "Curated skill tags list",
  responses: {
    200: json(
      z.array(z.object({ slug: z.string(), label: z.string() })),
      "Skill tags list",
    ),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/saved",
  tags: ["Jobs"],
  summary: "Get bookmarked jobs for the authenticated user",
  security: auth,
  responses: {
    200: json(z.array(job), "Bookmarked jobs"),
    401: errors[401],
  },
});

registry.registerPath({
  method: "post",
  path: "/api/jobs/{id}/save",
  tags: ["Jobs"],
  summary: "Bookmark a job",
  security: auth,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: json(z.object({ saved: z.boolean() }), "Bookmark created"),
    401: errors[401],
    404: errors[404],
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/jobs/{id}/save",
  tags: ["Jobs"],
  summary: "Remove a job bookmark",
  security: auth,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: json(z.object({ saved: z.boolean() }), "Bookmark removed"),
    401: errors[401],
    404: errors[404],
  },
});

// ---------------------------------------------------------------------------
// Escrow (build unsigned transactions)
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/api/escrow/build/create",
  tags: ["Escrow"],
  summary: "Build escrow.create",
  security: auth,
  request: { body: { content: { "application/json": { schema: buildCreateSchema } } } },
  responses: { 200: json(unsignedTransaction, "Unsigned transaction"), 400: errors[400], 401: errors[401], 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: "post",
  path: "/api/escrow/build/fund",
  tags: ["Escrow"],
  summary: "Build escrow.fund",
  security: auth,
  request: { body: { content: { "application/json": { schema: z.object({ escrowId: z.number().int().nonnegative() }) } } } },
  responses: { 200: json(unsignedTransaction, "Unsigned transaction"), 400: errors[400], 401: errors[401] },
});

registry.registerPath({
  method: "post",
  path: "/api/escrow/build/release",
  tags: ["Escrow"],
  summary: "Build escrow.release_milestone",
  security: auth,
  request: { body: { content: { "application/json": { schema: releaseSchema } } } },
  responses: { 200: json(unsignedTransaction, "Unsigned transaction"), 400: errors[400], 401: errors[401] },
});

registry.registerPath({
  method: "post",
  path: "/api/escrow/build/reclaim",
  tags: ["Escrow"],
  summary: "Build escrow.reclaim_expired",
  security: auth,
  request: { body: { content: { "application/json": { schema: escrowSyncSchema } } } },
  responses: { 200: json(unsignedTransaction, "Unsigned transaction"), 400: errors[400], 401: errors[401] },
});

registry.registerPath({
  method: "post",
  path: "/api/escrow/build/reclaim-dispute",
  tags: ["Escrow"],
  summary: "Build escrow.reclaim_after_dispute_timeout",
  description:
    "The client-only escape hatch once the configured dispute timelock passes with no ruling.",
  security: auth,
  request: { body: { content: { "application/json": { schema: escrowSyncSchema } } } },
  responses: { 200: json(unsignedTransaction, "Unsigned transaction"), 400: errors[400], 401: errors[401] },
});

registry.registerPath({
  method: "post",
  path: "/api/escrow/build/update-milestones",
  tags: ["Escrow"],
  summary: "Build escrow.update_milestones (client, before funding)",
  security: auth,
  request: { body: { content: { "application/json": { schema: updateMilestonesSchema } } } },
  responses: { 200: json(unsignedTransaction, "Unsigned transaction"), 400: errors[400], 401: errors[401], 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: "put",
  path: "/api/escrow/{escrowId}/milestones",
  tags: ["Escrow"],
  summary: "Record a confirmed milestone edit",
  security: auth,
  request: {
    params: z.object({ escrowId: z.string() }),
    body: { content: { "application/json": { schema: recordMilestonesSchema } } },
  },
  responses: { 200: json(job, "The updated job with its new milestones"), 400: errors[400], 401: errors[401], 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: "post",
  path: "/api/escrow/sync/{jobId}",
  tags: ["Escrow"],
  summary: "Link an on-chain escrow id to a job record",
  security: auth,
  request: {
    params: z.object({ jobId: z.string() }),
    body: { content: { "application/json": { schema: escrowSyncSchema } } },
  },
  responses: { 200: json(job, "The updated job"), 401: errors[401], 404: errors[404] },
});

registry.registerPath({
  method: "get",
  path: "/api/escrow/{escrowId}/receipt",
  tags: ["Escrow"],
  summary: "Get escrow receipt",
  request: { params: z.object({ escrowId: z.string() }) },
  responses: {
    200: json(z.record(z.unknown()), "Escrow receipt"),
    400: errors[400],
    404: errors[404],
  },
});

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/api/disputes",
  tags: ["Disputes"],
  summary: "Record a dispute and build escrow.open_dispute",
  security: auth,
  request: { body: { content: { "application/json": { schema: raiseSchema } } } },
  responses: {
    201: json(z.object({ dispute, xdr: z.string() }), "The dispute row and its unsigned transaction"),
    400: errors[400],
    401: errors[401],
    403: errors[403],
    404: errors[404],
  },
});

registry.registerPath({
  method: "get",
  path: "/api/disputes/{id}",
  tags: ["Disputes"],
  summary: "Get a dispute with its job",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: json(dispute, "The dispute"), 404: errors[404] },
});

registry.registerPath({
  method: "post",
  path: "/api/disputes/{id}/raise",
  tags: ["Disputes"],
  summary: "Build dispute.raise",
  security: auth,
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: json(unsignedTransaction, "Unsigned transaction"), 401: errors[401], 403: errors[403], 404: errors[404], 409: errors[409] },
});

registry.registerPath({
  method: "post",
  path: "/api/disputes/{id}/sync",
  tags: ["Disputes"],
  summary: "Record the on-chain dispute id",
  security: auth,
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: disputeSyncSchema } } },
  },
  responses: { 200: json(dispute, "The updated dispute"), 401: errors[401], 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: "post",
  path: "/api/disputes/{id}/resolve",
  tags: ["Disputes"],
  summary: "Build dispute.arbitrate (arbitrator only)",
  security: auth,
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: resolveSchema } } },
  },
  responses: {
    200: json(unsignedTransaction, "Unsigned transaction"),
    400: errors[400],
    401: errors[401],
    403: errors[403],
    404: errors[404],
    409: errors[409],
    503: { description: "No ARBITRATOR_ADDRESSES configured — resolution fails closed" },
  },
});

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/api/reputation",
  tags: ["Reputation"],
  summary: "Record a rating and build reputation.submit",
  security: auth,
  request: { body: { content: { "application/json": { schema: submitSchema } } } },
  responses: {
    201: json(z.object({ rating, xdr: z.string() }), "The rating row and its unsigned transaction"),
    400: errors[400],
    401: errors[401],
    404: errors[404],
  },
});

registry.registerPath({
  method: "get",
  path: "/api/reputation/{address}",
  tags: ["Reputation"],
  summary: "Get an address's weighted aggregate reputation",
  description:
    "Mirrors `reputation.get_aggregate`: each counted rating is weighted by its escrow's " +
    "total amount, and only the first rating from a given rater counts. `totalScore` and " +
    "`weight` are the contract's u64 fields as decimal strings; `averageScore` is " +
    "`totalScore / weight` (0 when there are no counted ratings).",
  request: { params: z.object({ address: z.string() }) },
  responses: {
    200: json(
      z.object({
        address: z.string(),
        averageScore: z.number(),
        totalScore: z.string(),
        weight: z.string(),
        count: z.number().int(),
        totalRatings: z.number().int(),
      }),
      "The aggregate",
    ),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/reputation/{address}/ratings",
  tags: ["Reputation"],
  summary: "List ratings received by address",
  request: { params: z.object({ address: z.string() }) },
  responses: {
    200: json(z.array(rating), "List of ratings"),
  },
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/api/messages/unread",
  tags: ["Messages"],
  summary: "Unread message counts for the authenticated user",
  security: auth,
  responses: {
    200: json(
      z.object({
        total: z.number().int(),
        byJob: z.array(z.object({ jobId: z.string(), count: z.number().int() })),
      }),
      "Unread counts, total and per job",
    ),
    401: errors[401],
  },
});

registry.registerPath({
  method: "get",
  path: "/api/messages/{jobId}",
  tags: ["Messages"],
  summary: "Read a job's conversation (participants only)",
  security: auth,
  request: { params: z.object({ jobId: z.string() }) },
  responses: {
    200: json(z.array(conversationMessage), "The conversation, oldest first"),
    401: errors[401],
    403: errors[403],
    404: errors[404],
  },
});

registry.registerPath({
  method: "post",
  path: "/api/messages/{jobId}",
  tags: ["Messages"],
  summary: "Send a message to the job's other participant",
  security: auth,
  request: {
    params: z.object({ jobId: z.string() }),
    body: { content: { "application/json": { schema: sendMessageSchema } } },
  },
  responses: {
    201: json(message, "The stored message"),
    400: errors[400],
    401: errors[401],
    403: errors[403],
    404: errors[404],
  },
});

registry.registerPath({
  method: "post",
  path: "/api/messages/{jobId}/read",
  tags: ["Messages"],
  summary: "Mark the other party's messages in this job as read",
  security: auth,
  request: { params: z.object({ jobId: z.string() }) },
  responses: {
    200: json(z.object({ markedRead: z.number().int() }), "How many messages were marked read"),
    401: errors[401],
    403: errors[403],
    404: errors[404],
  },
});

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * The finished document. Built eagerly at import: it is a pure transformation
 * of the schemas above, so a schema zod-to-openapi cannot render fails loudly
 * at boot (and in CI) instead of when a user opens `/api/docs`.
 */
export const openApiDocument = new OpenApiGeneratorV3(registry.definitions).generateDocument({
  openapi: "3.0.3",
  info: {
    title: "Stellar Freelance Payment Platform API",
    version: "0.1.0",
    description:
      "Express + Prisma API for the decentralized freelance payment platform. " +
      "Mutating routes that touch the chain return an unsigned XDR for the client to " +
      "sign; the backend never holds keys. Auth is a JWT from POST /api/users/auth.",
  },
  servers: [{ url: "http://localhost:3000", description: "Local development" }],
  tags: [
    { name: "System", description: "Health and readiness" },
    { name: "Users", description: "Wallet auth (SEP-53) and profiles" },
    { name: "Jobs", description: "Off-chain job records mirroring on-chain escrow" },
    { name: "Escrow", description: "Build unsigned escrow contract transactions" },
    { name: "Disputes", description: "Raise, sync and arbitrate disputes" },
    { name: "Reputation", description: "On-chain ratings and aggregates" },
    { name: "Messages", description: "Job-scoped conversation between the two participants" },
  ],
});
