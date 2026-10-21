-- Issue #168: `handleResolved` used to mark every milestone of a resolved
-- escrow RELEASED without writing `releasedAmount`, leaving the column at its
-- `0` default. `escrow.resolve` sets each on-chain milestone's
-- `released_amount` to its full `amount` in the same transaction, so every
-- aggregate built on `releasedAmount` (earnings, payment history, audit
-- totals) under-counted arbitrated escrows until the handler was fixed.
--
-- The indexer cursor has already moved past those events, so a code change
-- alone cannot repair rows that were indexed before it. Backfill them here.
--
-- Scoped to jobs with a RESOLVED dispute because that is exactly the path
-- `handleResolved` mirrors: `escrow.resolve` is only callable while Disputed,
-- and it releases every milestone in full. A normal completion writes
-- `releasedAmount` through `handleMilestoneReleased`, so it is left untouched.
-- `<>` rather than `= 0` also repairs a milestone that had a partial release
-- recorded before the dispute froze the escrow.
UPDATE "Milestone" AS m
SET "releasedAmount" = m."amount"
FROM "Job" AS j
WHERE m."jobId" = j.id
  AND m.status = 'RELEASED'
  AND m."releasedAmount" <> m."amount"
  AND j.status = 'COMPLETED'
  AND EXISTS (
    SELECT 1
    FROM "Dispute" AS d
    WHERE d."jobId" = j.id
      AND d.status = 'RESOLVED'
  );
