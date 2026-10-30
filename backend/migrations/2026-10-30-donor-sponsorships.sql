-- Donor sponsorships: which donor funds which student.
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code.
-- Safe to run twice. Creates one new table; changes nothing existing.
--
-- Why a join table rather than a column on `students`: a column would ride
-- along in fromStudent() and appear in every student payload, so keeping the
-- allocation away from parents and students would depend on remembering to
-- strip it in the parent scope, the teacher scope and the client-side
-- re-scope. As a separate table there is nothing to leak — the student row a
-- parent receives has no sponsorship field at all.
--
-- `notes` holds internal staff context and must never reach the donor scope.

create table if not exists donor_sponsorships (
  id              text primary key,
  donor_id        text not null,
  student_id      text not null,
  allocated_by    text,
  allocated_by_id text,
  allocated_at    timestamptz default now(),
  status          text default 'active',     -- 'active' | 'ended'
  ended_at        timestamptz,
  ended_by        text,
  notes           text,
  unique (donor_id, student_id)
);

create index if not exists idx_sponsorship_donor   on donor_sponsorships (donor_id);
create index if not exists idx_sponsorship_student on donor_sponsorships (student_id);
create index if not exists idx_sponsorship_status  on donor_sponsorships (status);

alter table donor_sponsorships enable row level security;
