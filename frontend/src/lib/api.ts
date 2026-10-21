/**
 * api.ts
 *
 * Minimal client for the backend REST API. Only the endpoints the frontend
 * needs; `VITE_API_URL` configures the base URL (default localhost:3000).
 *
 * Contributor Notes:
 * - Jobs reach this client from the backend, whose contract-event indexer
 *   (`backend/src/indexer.ts`) syncs chain state into the database. A job can
 *   therefore appear here without this client having created it.
 * - `totalAmount`/`escrowId` come from Prisma and may serialize as strings.
 * - `authenticate` caches the JWT it gets back, per address: signing the
 *   challenge prompts the wallet, and the messaging view would otherwise prompt
 *   on every unread refresh. See the comment on the cache below.
 */

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

/**
 * How long a token from `authenticate` is reused.
 *
 * Deliberately under the server's 7-day JWT expiry, so a cached token is never
 * presented after the server has stopped accepting it.
 */
const TOKEN_TTL_MS = 6 * 24 * 60 * 60 * 1000;

/** Signed-in sessions, keyed by Stellar address. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
/** In-flight challenges, so two components mounting together share one prompt. */
const pendingAuth = new Map<string, Promise<string>>();

/** Drop a cached token (all addresses when called with none). */
export function clearAuthToken(address?: string): void {
  if (address === undefined) tokenCache.clear();
  else tokenCache.delete(address);
}

export interface JobListQuery {
  status?: string;
  client?: string;
  freelancer?: string;
  /** Curated skill-tag slug (see `lib/tags.ts`); issue #70. */
  tag?: string;
  /** Keyword search across title + description (issue #62). */
  q?: string;
  /** `newest` | `oldest` | `amount_desc` | `amount_asc` (issue #62). */
  sort?: string;
  page?: number;
  limit?: number;
}

/** Build the `/api/jobs` query string, omitting empty filters. */
export function buildJobsQuery(query: JobListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.client) params.set("client", query.client);
  if (query.freelancer) params.set("freelancer", query.freelancer);
  if (query.q) params.set("q", query.q);
  if (query.sort) params.set("sort", query.sort);
  if (query.tag) params.set("tag", query.tag);
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** A freelancer's application for an open job (issue #63). */
export interface ProposalApi {
  id: string;
  jobId: string;
  freelancerId: string;
  coverLetter?: string | null;
  proposedRate?: string | number | null;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  createdAt: string;
  freelancer?: {
    id: string;
    stellarAddress: string;
    displayName?: string | null;
  };
}

/** A milestone row as the jobs API returns it (see the Prisma model). */
/** A file attached to a milestone as proof of delivery (issue #65). */
export interface DeliverableApi {
  id: string;
  milestoneId: string;
  fileName: string;
  fileUrl: string;
  fileSize?: number | null;
  fileType?: string | null;
  description?: string | null;
  createdAt: string;
  uploadedBy?: {
    stellarAddress: string;
    displayName?: string | null;
  };
}

export interface JobMilestoneApi {
  id?: string;
  index?: number;
  amount: string | number;
  description?: string | null;
  status: string;
  deadline?: string | null;
  releasedAt?: string | null;
  /** Amount released so far for partial releases (issue #175). */
  releasedAmount?: string | number;
  /** Deliverable files a freelancer attached (issue #65). */
  deliverables?: DeliverableApi[];
}

export interface JobApi {
  id: string;
  /** On-chain escrow id, present only once the job has been funded on-chain. */
  escrowId: string | number | null;
  title: string;
  description?: string;
  status: string;
  /** Asset symbol the job pays in (see lib/assets.ts). */
  asset?: string;
  /** Curated skill-tag slugs (see lib/tags.ts); issue #70. */
  tags?: string[];
  totalAmount: string | number;
  /** ISO timestamp the off-chain record was created; used to order history. */
  createdAt?: string;
  client?: { stellarAddress: string; displayName?: string | null } | null;
  freelancer?: { stellarAddress: string } | null;
  /** Present on the list/detail responses; used by the activity summary (#73). */
  milestones?: JobMilestoneApi[];
  /** Present on the detail response; freelancer applications (issue #63). */
  proposals?: ProposalApi[];
}

/** Fetch a page of jobs. Throws on a non-2xx response. */
export async function fetchJobs(
  query: JobListQuery = {},
  signal?: AbortSignal,
): Promise<JobApi[]> {
  const res = await fetch(`${API_BASE_URL}/api/jobs${buildJobsQuery(query)}`, {
    signal,
  });
  if (!res.ok) throw new Error(`Could not load jobs (HTTP ${res.status})`);
  return (await res.json()) as JobApi[];
}

/** Fetch a single job by id (used for milestone deliverables, issue #65). */
export async function fetchJob(id: string): Promise<JobApi> {
  const res = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Could not load job (HTTP ${res.status})`);
  return (await res.json()) as JobApi;
}

/** Fetch the proposals submitted for a job (issue #63). */
export async function fetchProposals(jobId: string): Promise<ProposalApi[]> {
  const res = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/proposals`);
  if (!res.ok) throw new Error(`Could not load proposals (HTTP ${res.status})`);
  return (await res.json()) as ProposalApi[];
}

/** Submit an application for an open job (issue #63). */
export async function submitProposal(
  jobId: string,
  input: { coverLetter?: string; proposedRate?: string | number },
  token: string,
): Promise<ProposalApi> {
  const res = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/proposals`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const errorData = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorData?.error ?? `Could not submit proposal (HTTP ${res.status})`);
  }
  return (await res.json()) as ProposalApi;
}

/** Assign a freelancer to a job, accepting that proposal (issue #63). */
export async function assignFreelancer(
  jobId: string,
  freelancerAddress: string,
  token: string,
): Promise<JobApi> {
  const res = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/assign`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ freelancerAddress }),
  });
  if (!res.ok) {
    const errorData = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorData?.error ?? `Could not assign freelancer (HTTP ${res.status})`);
  }
  return (await res.json()) as JobApi;
}

/**
 * Every job an address took part in, as client or as freelancer.
 *
 * The API filters by one role at a time, so this asks for both and merges them:
 * a job where the same address is somehow both parties must not be listed twice.
 * Newest first, using `createdAt` when the API provided one.
 */
export async function fetchUserJobs(
  address: string,
  signal?: AbortSignal,
): Promise<JobApi[]> {
  const [asClient, asFreelancer] = await Promise.all([
    fetchJobs({ client: address, limit: 100 }, signal),
    fetchJobs({ freelancer: address, limit: 100 }, signal),
  ]);
  const byId = new Map<string, JobApi>();
  for (const job of [...asClient, ...asFreelancer]) byId.set(job.id, job);
  return [...byId.values()].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );
}

/** A single rating an address received, with the job it refers to. */
export interface ReceivedRatingApi {
  id: string;
  score: number;
  comment: string | null;
  /** ISO timestamp the rating was stored. */
  createdAt: string;
  job?: { id: string; title: string; escrowId: string | number | null; status: string } | null;
  rater?: { stellarAddress: string } | null;
}

/**
 * The individual ratings an address received, newest first (issue #69).
 *
 * `GET /api/reputation/:address` only returns the aggregate; this is the detail
 * behind it — score, job and date per rating.
 */
export async function fetchRatingsReceived(
  address: string,
  signal?: AbortSignal,
): Promise<ReceivedRatingApi[]> {
  const res = await fetch(
    `${API_BASE_URL}/api/reputation/${encodeURIComponent(address)}/ratings`,
    { signal },
  );
  if (!res.ok) throw new Error(`Could not load ratings (HTTP ${res.status})`);
  return (await res.json()) as ReceivedRatingApi[];
}

/**
 * One indexed contract event, as the history endpoint returns it (issue #72).
 *
 * `amount` is already in whole units of `asset` (like `JobApi.totalAmount`),
 * so it is shown as-is; `txHash` is what `explorerTxUrl` turns into a link.
 */
export interface TransactionApi {
  id: string;
  escrowId: string;
  action: string;
  amount: string | null;
  asset: string | null;
  txHash: string | null;
  ledger: number;
  createdAt: string;
}

export interface TransactionHistoryApi {
  data: TransactionApi[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** The on-chain history for an address's escrows, newest ledger first. */
export async function fetchTransactions(
  address: string,
  page = 1,
  limit = 20,
  signal?: AbortSignal,
): Promise<TransactionHistoryApi> {
  const res = await fetch(
    `${API_BASE_URL}/api/users/${encodeURIComponent(address)}/transactions?page=${page}&limit=${limit}`,
    { signal },
  );
  if (!res.ok) throw new Error(`Could not load transactions (HTTP ${res.status})`);
  return (await res.json()) as TransactionHistoryApi;
}

/** How a milestone deadline reads right now (issue #74). */
export type ReminderKind = "overdue" | "due-soon";

/** A milestone deadline that has passed or is coming up. */
export interface ReminderApi {
  jobId: string;
  title: string;
  escrowId: string | null;
  milestoneIndex: number;
  description: string | null;
  /** Whole units of the job's asset. */
  amount: string;
  deadline: string;
  kind: ReminderKind;
  role: "client" | "freelancer";
}

/**
 * The milestone reminders for an address's open jobs, overdue first.
 *
 * The deadlines are evaluated by the server against its own clock, so the client
 * only decides how to present `kind`.
 */
export async function fetchReminders(
  address: string,
  signal?: AbortSignal,
): Promise<ReminderApi[]> {
  const res = await fetch(
    `${API_BASE_URL}/api/users/${encodeURIComponent(address)}/reminders`,
    { signal },
  );
  if (!res.ok) throw new Error(`Could not load reminders (HTTP ${res.status})`);
  return (await res.json()) as ReminderApi[];
}

/** One milestone as the receipt reports it. */
export interface ReceiptMilestoneApi {
  index: number;
  description: string | null;
  /** Whole units of the job's asset. */
  amount: string;
  status: string;
  deadline: string | null;
  releasedAt: string | null;
}

/** One indexed event as the receipt reports it. */
export interface ReceiptEventApi {
  id: string;
  action: string;
  /** Whole units of the job's asset, or null when the event moved nothing. */
  amount: string | null;
  /** Transaction that emitted the event, for the explorer link. */
  txHash: string | null;
  ledger: number;
  createdAt: string;
}

/**
 * A printable/exportable record of one escrow (issue #77): what was agreed, what
 * was released, and the transaction behind each step.
 */
export interface EscrowReceiptApi {
  escrowId: string;
  generatedAt: string;
  job: {
    id: string;
    title: string;
    description: string;
    status: string;
    asset: string;
    totalAmount: string;
    createdAt: string;
    expiresAt: string | null;
    client: { stellarAddress: string; displayName: string | null } | null;
    freelancer: { stellarAddress: string; displayName: string | null } | null;
  };
  milestones: ReceiptMilestoneApi[];
  events: ReceiptEventApi[];
  totals: { released: string; outstanding: string };
}

/** Fetch the receipt for an escrow. Throws, with the status, on a non-2xx. */
export async function fetchReceipt(
  escrowId: string | number | bigint,
  signal?: AbortSignal,
): Promise<EscrowReceiptApi> {
  const res = await fetch(
    `${API_BASE_URL}/api/escrow/${encodeURIComponent(String(escrowId))}/receipt`,
    { signal },
  );
  if (!res.ok) throw new Error(`Could not load the receipt (HTTP ${res.status})`);
  return (await res.json()) as EscrowReceiptApi;
}

// ---------------------------------------------------------------------------
// Authenticated writes
// ---------------------------------------------------------------------------

export interface CreateJobMilestoneInput {
  description?: string;
  /**
   * Whole units of the job asset. A decimal string is exact and preferred; a
   * number is accepted but is already a binary float by the time it arrives.
   */
  amount: number | string;
  deadline?: string;
}

export interface CreateJobInput {
  title: string;
  description: string;
  /** Asset symbol the job pays in; the backend stores it on the job. */
  asset: string;
  /**
   * Curated skill-tag slugs describing the work (see lib/tags.ts). Optional:
   * the API defaults an absent list to none, so an older client still works.
   */
  tags?: string[];
  milestones: CreateJobMilestoneInput[];
  expiresAt?: string;
}

/**
 * The caller's bookmarked jobs, most recently saved first (issue #71).
 *
 * Returns the same shape as `fetchJobs`, so the dashboard renders a saved job
 * with the component it already uses for every other row.
 */
export async function fetchSavedJobs(token: string): Promise<JobApi[]> {
  const res = await fetch(`${API_BASE_URL}/api/jobs/saved`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not load saved jobs (HTTP ${res.status})`);
  return (await res.json()) as JobApi[];
}

/** Bookmark a job. Idempotent on the server, so a double click is harmless. */
export async function saveJob(jobId: string, token: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/save`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not save the job (HTTP ${res.status})`);
}

/** Remove a bookmark. Unsaving one that was never saved is not an error. */
export async function unsaveJob(jobId: string, token: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/save`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not remove the bookmark (HTTP ${res.status})`);
}

/**
 * Complete the wallet challenge-response flow and return a bearer token.
 * `signMessage` signs the challenge nonce per SEP-53 (see Freighter).
 *
 * The token is cached per address and reused for `TOKEN_TTL_MS`, because every
 * signature is a wallet prompt: without this, a page that refreshes an
 * authenticated read would ask the user to sign each time. Concurrent callers
 * that miss the cache share a single in-flight challenge for the same reason.
 * Pass `{ fresh: true }` to force a new challenge (e.g. after a 401).
 */
export async function authenticate(
  address: string,
  signMessage: (message: string) => Promise<string>,
  options: { fresh?: boolean } = {},
): Promise<string> {
  if (!options.fresh) {
    const cached = tokenCache.get(address);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const inflight = pendingAuth.get(address);
    if (inflight) return inflight;
  }

  const challenge = (async () => {
    const challengeRes = await fetch(
      `${API_BASE_URL}/api/users/challenge?address=${encodeURIComponent(address)}`,
    );
    if (!challengeRes.ok) {
      throw new Error(`Could not get an auth challenge (HTTP ${challengeRes.status})`);
    }
    const { nonce } = (await challengeRes.json()) as { nonce: string };

    const signature = await signMessage(nonce);
    const authRes = await fetch(`${API_BASE_URL}/api/users/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, signature, nonce }),
    });
    if (!authRes.ok) throw new Error(`Authentication failed (HTTP ${authRes.status})`);
    const { token } = (await authRes.json()) as { token: string };
    tokenCache.set(address, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
  })();

  pendingAuth.set(address, challenge);
  try {
    return await challenge;
  } finally {
    pendingAuth.delete(address);
  }
}

/** Create the off-chain job record (requires a token from `authenticate`). */
export async function createJob(input: CreateJobInput, token: string): Promise<JobApi> {
  const res = await fetch(`${API_BASE_URL}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Could not save the job (HTTP ${res.status})`);
  return (await res.json()) as JobApi;
}

/** Attach the on-chain escrow id to an existing job record. */
export async function linkEscrowId(
  jobId: string,
  escrowId: number,
  token: string,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/escrow/sync/${jobId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ escrowId }),
  });
  if (!res.ok) throw new Error(`Could not link the escrow (HTTP ${res.status})`);
}

export interface SubmitRatingInput {
  /** Off-chain job id — the API keys the rating on this, not the escrow id. */
  jobId: string;
  rateeAddress: string;
  score: number;
  comment?: string;
}

export interface SubmittedRating {
  id: string;
  jobId: string;
  score: number;
  comment: string | null;
}

/**
 * Record a rating off-chain and receive the server-built `reputation.submit`
 * transaction.
 *
 * The server keys the row on `(rater, job)` — the same key the indexer uses for
 * the `rated` event — so the two converge instead of duplicating.
 *
 * The returned `xdr` is not used by the app: the rating is submitted through
 * `useEscrow.submitRating`, which encodes the arguments itself (`scU32` score),
 * so the on-chain call is correct regardless of the API's builder. This client
 * is for the off-chain record (the contract stores no comment) and for
 * API-first integrators.
 */
export async function submitRating(
  input: SubmitRatingInput,
  token: string,
): Promise<{ rating: SubmittedRating; xdr: string }> {
  const res = await fetch(`${API_BASE_URL}/api/reputation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Could not record the rating (HTTP ${res.status})`);
  return (await res.json()) as { rating: SubmittedRating; xdr: string };
}

export interface DisputeApi {
  id: string;
  jobId: string;
  /** Set once `dispute.raise` has confirmed (see `linkDisputeId`). */
  onChainId: string | number | null;
  status: string;
  reason: string;
}

/**
 * Record a dispute off-chain and receive the server-built `escrow.open_dispute`
 * transaction.
 *
 * The row is written before either transaction runs because the `raised` event
 * carries no reason: this row is the only place the reason the panel reads is
 * kept. Keyed on the job, so calling it twice (both parties may) returns the
 * same dispute instead of a second one.
 *
 * As with `submitRating`, the returned `xdr` is not what the app submits —
 * `useEscrow.openDispute` encodes `open_dispute` itself, so the on-chain call
 * does not depend on the API's builder. This is the off-chain record, and what
 * API-first integrators follow.
 */
export async function createDispute(
  input: { jobId: string; reason: string },
  token: string,
): Promise<{ dispute: DisputeApi; xdr: string }> {
  const res = await fetch(`${API_BASE_URL}/api/disputes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Could not record the dispute (HTTP ${res.status})`);
  return (await res.json()) as { dispute: DisputeApi; xdr: string };
}

/**
 * Attach the on-chain dispute id that `dispute.raise` returned to the row.
 *
 * Without this the id only arrives when the indexer next sees the `raised`
 * event, and `POST /api/disputes/:id/resolve` refuses until then. The indexer
 * writes the same field on the same row, so this is a head start, not a second
 * source of truth.
 */
export async function linkDisputeId(
  disputeId: string,
  onChainId: number | bigint,
  token: string,
): Promise<DisputeApi> {
  const res = await fetch(`${API_BASE_URL}/api/disputes/${disputeId}/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ onChainId: Number(onChainId) }),
  });
  if (!res.ok) throw new Error(`Could not record the dispute id (HTTP ${res.status})`);
  return (await res.json()) as DisputeApi;
}

// ---------------------------------------------------------------------------
// Notifications (#66)
// ---------------------------------------------------------------------------

export interface NotificationApi {
  id: string;
  userId: string;
  jobId: string | null;
  type: "FUNDED" | "RELEASED" | "DISPUTED" | "RESOLVED";
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: NotificationApi[];
  unreadCount: number;
}

/** Fetch user notifications (requires bearer token). */
export async function fetchNotifications(
  token: string,
  unreadOnly = false,
  signal?: AbortSignal,
): Promise<NotificationsResponse> {
  const res = await fetch(
    `${API_BASE_URL}/api/notifications${unreadOnly ? "?unread=true" : ""}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    },
  );
  if (!res.ok) throw new Error(`Could not load notifications (HTTP ${res.status})`);
  return (await res.json()) as NotificationsResponse;
}

/** Mark a single notification as read. */
export async function markNotificationRead(
  token: string,
  notificationId: string,
): Promise<NotificationApi> {
  const res = await fetch(`${API_BASE_URL}/api/notifications/${notificationId}/read`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not mark notification as read (HTTP ${res.status})`);
  return (await res.json()) as NotificationApi;
}

/** Mark all notifications for the user as read. */
export async function markAllNotificationsRead(token: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/notifications/read-all`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not mark all notifications as read (HTTP ${res.status})`);
}

// ---------------------------------------------------------------------------
// Freelancer Directory (#68)
// ---------------------------------------------------------------------------

export interface FreelancerApi {
  id: string;
  stellarAddress: string;
  displayName: string | null;
  bio: string | null;
  createdAt: string;
  averageScore: number;
  totalRatings: number;
  completedJobsCount: number;
  totalJobsCount: number;
}

export interface FreelancerListQuery {
  search?: string;
  sortBy?: "reputation" | "jobs" | "recent";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface FreelancersResponse {
  freelancers: FreelancerApi[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Build the `/api/users/freelancers` query string, omitting empty filters. */
export function buildFreelancersQuery(query: FreelancerListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.sortBy) params.set("sortBy", query.sortBy);
  if (query.sortOrder) params.set("sortOrder", query.sortOrder);
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Fetch a page of freelancers from the directory. Throws on non-2xx response. */
export async function fetchFreelancers(
  query: FreelancerListQuery = {},
  signal?: AbortSignal,
): Promise<FreelancersResponse> {
  const res = await fetch(
    `${API_BASE_URL}/api/users/freelancers${buildFreelancersQuery(query)}`,
    { signal },
  );
  if (!res.ok) throw new Error(`Could not load freelancers (HTTP ${res.status})`);
  const data = await res.json();
  if (Array.isArray(data)) {
    return {
      freelancers: data,
      total: data.length,
      page: 1,
      limit: data.length,
      totalPages: 1,
    };
  }
  return data as FreelancersResponse;
}

// ---------------------------------------------------------------------------
// Messaging (issue #64)
// ---------------------------------------------------------------------------

/**
 * A job-scoped message. `jobId` is the off-chain job id, not the escrow id, and
 * `sender` is included by the conversation endpoint so the view can tell the two
 * parties apart without a second lookup.
 */
export interface MessageApi {
  id: string;
  jobId: string;
  senderId: string;
  body: string;
  createdAt: string;
  /** Set once the recipient has read it; `null` means unread. */
  readAt: string | null;
  sender?: { stellarAddress: string; displayName?: string | null };
}

/** Unread counts for the authenticated user: a total, and one per job. */
export interface UnreadCounts {
  total: number;
  byJob: { jobId: string; count: number }[];
}

/**
 * Read a job's conversation. Only the job's two participants may call this; a
 * third party gets a 403 from the API.
 */
export async function fetchMessages(jobId: string, token: string): Promise<MessageApi[]> {
  const res = await fetch(`${API_BASE_URL}/api/messages/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not load the conversation (HTTP ${res.status})`);
  return (await res.json()) as MessageApi[];
}

/** Send a message to the job's other participant. */
export async function sendMessage(
  jobId: string,
  body: string,
  token: string,
): Promise<MessageApi> {
  const res = await fetch(`${API_BASE_URL}/api/messages/${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`Could not send the message (HTTP ${res.status})`);
  return (await res.json()) as MessageApi;
}

/** Mark the other party's messages in this job read; returns how many changed. */
export async function markMessagesRead(jobId: string, token: string): Promise<number> {
  const res = await fetch(
    `${API_BASE_URL}/api/messages/${encodeURIComponent(jobId)}/read`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Could not update read state (HTTP ${res.status})`);
  const { markedRead } = (await res.json()) as { markedRead: number };
  return markedRead;
}

/** Total unread messages, plus one count per job, for the authenticated user. */
export async function fetchUnreadCounts(token: string): Promise<UnreadCounts> {
  const res = await fetch(`${API_BASE_URL}/api/messages/unread`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not load unread counts (HTTP ${res.status})`);
  return (await res.json()) as UnreadCounts;
}

// ---------------------------------------------------------------------------
// Milestone deliverables (issue #65)
// ---------------------------------------------------------------------------

/** Attach a deliverable to a milestone by milestone id. */
export async function uploadDeliverable(
  milestoneId: string,
  input: {
    fileName: string;
    fileUrl: string;
    fileSize?: number;
    fileType?: string;
    description?: string;
  },
  token: string,
): Promise<DeliverableApi> {
  const res = await fetch(
    `${API_BASE_URL}/api/milestones/${encodeURIComponent(milestoneId)}/deliverables`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const errorData = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorData?.error ?? `Could not upload deliverable (HTTP ${res.status})`);
  }
  return (await res.json()) as DeliverableApi;
}

/** Attach a deliverable to a milestone by job id and index. */
export async function uploadJobMilestoneDeliverable(
  jobId: string,
  milestoneIndex: number,
  input: {
    fileName: string;
    fileUrl: string;
    fileSize?: number;
    fileType?: string;
    description?: string;
  },
  token: string,
): Promise<DeliverableApi> {
  const res = await fetch(
    `${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/milestones/${milestoneIndex}/deliverables`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const errorData = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorData?.error ?? `Could not upload deliverable (HTTP ${res.status})`);
  }
  return (await res.json()) as DeliverableApi;
}

/** Fetch a milestone's deliverables by milestone id. */
export async function fetchMilestoneDeliverables(
  milestoneId: string,
): Promise<DeliverableApi[]> {
  const res = await fetch(
    `${API_BASE_URL}/api/milestones/${encodeURIComponent(milestoneId)}/deliverables`,
  );
  if (!res.ok) throw new Error(`Could not load deliverables (HTTP ${res.status})`);
  return (await res.json()) as DeliverableApi[];
}

/** Fetch a milestone's deliverables by job id and index. */
export async function fetchJobMilestoneDeliverables(
  jobId: string,
  milestoneIndex: number,
): Promise<DeliverableApi[]> {
  const res = await fetch(
    `${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/milestones/${milestoneIndex}/deliverables`,
  );
  if (!res.ok) throw new Error(`Could not load deliverables (HTTP ${res.status})`);
  return (await res.json()) as DeliverableApi[];
}

// ---------------------------------------------------------------------------
// Off-chain profile and notification preferences (issue #67)
// ---------------------------------------------------------------------------

export interface UserProfileApi {
  id: string;
  stellarAddress: string;
  displayName?: string | null;
  bio?: string | null;
  email?: string | null;
  notifyOnDispute?: boolean;
  notifyOnRelease?: boolean;
  notifyOnRefund?: boolean;
}

export interface UpdateUserProfileInput {
  displayName?: string;
  bio?: string;
  email?: string | null;
  notifyOnDispute?: boolean;
  notifyOnRelease?: boolean;
  notifyOnRefund?: boolean;
}

/** Read a public profile (and, for the owner, the notification preferences). */
export async function fetchUserProfile(
  address: string,
  signal?: AbortSignal,
): Promise<UserProfileApi | null> {
  const res = await fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(address)}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not fetch user profile (HTTP ${res.status})`);
  return (await res.json()) as UserProfileApi;
}

/** Update the authenticated user's profile and notification preferences. */
export async function updateUserProfile(
  input: UpdateUserProfileInput,
  token: string,
): Promise<UserProfileApi> {
  const res = await fetch(`${API_BASE_URL}/api/users/me`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Could not update profile (HTTP ${res.status})`);
  return (await res.json()) as UserProfileApi;
}

