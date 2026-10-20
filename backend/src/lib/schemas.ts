/**
 * schemas.ts
 *
 * Request schemas for the jobs API, extracted from the route file so the
 * validation rules are unit testable without a database, config or a running
 * server (see `__tests__/app.test.ts`).
 */

import { z } from "zod";
import { JobStatus } from "@prisma/client";
import { isSkillTag, MAX_JOB_TAGS, SKILL_TAG_SLUGS } from "./tags";
import { isValidStellarAddress } from "./stellarAddress";

/**
 * A milestone amount, in whole units of the job's asset (issue #41): a
 * positive number, or a positive decimal string. The field is asset-neutral,
 * so the same schema validates an XLM job and a USDC job.
 *
 * The string form lets a client send exactly what the user typed instead of a
 * binary float it round-tripped through `Number`, so the value the API stores
 * and sums is the value that was entered (see `sumAmounts` in lib/assets.ts).
 */
const amountSchema = z.union([
  z.number().positive(),
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Amount must be a positive decimal number")
    .refine((value) => Number(value) > 0, "Amount must be greater than zero"),
]);

export const milestoneSchema = z.object({
  description: z.string().optional(),
  amount: amountSchema,
  deadline: z.string().datetime().optional(),
});

/**
 * A job's skill tags: curated slugs from `lib/tags.ts`, de-duplicated and
 * capped. Defaults to none, so existing clients keep working unchanged.
 */
export const jobTagsSchema = z
  .array(
    z
      .string()
      .refine(isSkillTag, `Tags must be one of: ${SKILL_TAG_SLUGS.join(", ")}`),
  )
  .max(MAX_JOB_TAGS)
  .default([])
  .transform((tags) => [...new Set(tags)]);

export const createJobSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10),
  milestones: z.array(milestoneSchema).min(1),
  expiresAt: z.string().datetime().optional(),
  /** Asset symbol the job pays in; must be in the registry. Defaults to USDC. */
  asset: z.string().default("USDC"),
  /** Curated skill tags describing the work (issue #70). */
  tags: jobTagsSchema,
});

export const assignJobSchema = z.object({
  freelancerAddress: z
    .string()
    .refine(isValidStellarAddress, "Invalid Stellar address"),
});

/** Default page size for `GET /api/jobs` when `limit` is omitted. */
export const DEFAULT_PAGE_SIZE = 20;

/** Upper bound on `limit`, so one request cannot ask for the whole table. */
export const MAX_PAGE_SIZE = 100;

/**
 * Query string for `GET /api/jobs`.
 *
 * Every value arrives as a string (or an array of strings), so `page` and
 * `limit` are coerced to positive integers and `status` is checked against the
 * Prisma enum. Without this, `Number("abc")` became `NaN` in `skip`/`take`
 * (Prisma rejects it, surfacing a 500), an unknown status threw inside Prisma
 * (again a 500), and `limit` was unbounded. A bad value is now a 400.
 *
 * `status` uses `nativeEnum` rather than a hand-copied list so it cannot drift
 * from `JobStatus` in `schema.prisma`.
 */
export const listJobsQuerySchema = z.object({
  status: z.nativeEnum(JobStatus).optional(),
  client: z.string().optional(),
  freelancer: z.string().optional(),
  tag: z.string().optional(),
  /** Keyword search across title + description (issue #62). */
  q: z.string().trim().min(1).max(200).optional(),
  /** Ordering; the default is newest-first (issue #62). */
  sort: z.enum(["newest", "oldest", "amount_desc", "amount_asc"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const transactionHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const createProposalSchema = z.object({
  coverLetter: z.string().min(5).max(3000).optional(),
  proposedRate: amountSchema.optional(),
});

export const createDeliverableSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileUrl: z
    .string()
    .url("fileUrl must be a valid URL")
    .refine(
      (url) => url.startsWith("https://") || url.startsWith("http://"),
      "fileUrl must use the http or https scheme",
    ),
  fileSize: z.number().int().positive().optional(),
  fileType: z.string().max(100).optional(),
  description: z.string().max(1000).optional(),
});
