-- Audit log: structured detail + indexes for the new activity-history screen.
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code.
-- Safe to run twice; every statement is idempotent. No existing row changes —
-- the new columns are nullable and stay null on rows written before this.
--
-- Why: the audit log could only ever be read 100 rows deep (a hard limit in
-- readAllData), and every event was a single pre-flattened string, so nothing
-- was queryable per record. These columns carry the structured half of an
-- event alongside the human-readable one.

alter table audit_log add column if not exists actor_id text;
alter table audit_log add column if not exists actor_role text;
alter table audit_log add column if not exists entity_type text;   -- 'student' | 'fee' | 'auth' | 'export' | ...
alter table audit_log add column if not exists entity_id text;
alter table audit_log add column if not exists meta jsonb;

-- Filtering by actor and by record is the whole point of the new screen;
-- without these every filter is a sequential scan.
create index if not exists idx_audit_who on audit_log (who);
create index if not exists idx_audit_entity on audit_log (entity_type, entity_id);
create index if not exists idx_audit_action on audit_log (action);
