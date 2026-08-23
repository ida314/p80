-- 0004_job_retry_backoff — ADR 0027.
--
-- One nullable column: the earliest time a pending job may be claimed.
--
-- WHY A COLUMN AND NOT A SLEEP IN THE WORKER
-- ------------------------------------------
-- The defect this fixes is that a retryable failure re-ran with no delay at all. `failJob`
-- returned the job to `pending`, and the loop only sleeps when it claimed *nothing* — so a
-- failing job was re-claimed on the very next iteration and burned all three attempts in
-- milliseconds. Whatever transient condition the retry existed to outlast had not had time
-- to change.
--
-- The obvious fix is to sleep the worker after a failure. That works and it is wrong: it
-- delays every *other* job too, so one failing transcription stalls an unrelated ingest.
-- A backoff is a property of the job that failed, not of the process that ran it, so it
-- belongs in the row — and once it is in the row the claim query does the work, the loop
-- needs no change at all, and the wait survives a worker restart.
--
-- ADDING A COLUMN IS THE ONE SAFE SQLITE MIGRATION
-- ------------------------------------------------
-- `ALTER TABLE ... ADD COLUMN` rewrites no rows and drops no table, so it does not go near
-- the hazard migration 0002 and `02-database.md` both warn about: a 12-step rebuild under
-- `PRAGMA foreign_keys = ON` fires every `ON DELETE CASCADE` on the way through. That is
-- why the two deferred CHECK constraints are still deferred and this is not.
--
-- NULL means "claimable now", which is what every existing row is.
ALTER TABLE jobs ADD COLUMN available_at INTEGER;

-- The claim query filters on it alongside status, so it joins the claim index rather than
-- getting its own. Rebuilt rather than added to, because column order in a composite index
-- decides whether it can be used at all.
DROP INDEX IF EXISTS idx_jobs_claim;
CREATE INDEX idx_jobs_claim ON jobs(status, available_at, priority DESC, created_at);
