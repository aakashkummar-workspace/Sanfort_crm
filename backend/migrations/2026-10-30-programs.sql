-- School programs: the events the school itself conducts, with a
-- participant roster, attendance and results.
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code.
-- Safe to run twice; every statement is idempotent. No existing row changes —
-- the one altered table (student_activities) gains a nullable column that
-- stays null on every row written before this.
--
-- Why: today a sports day or inter-school competition can only be recorded
-- as free text in student_activities.event_name — once per student, with no
-- shared event record, so nothing can be counted, no roster exists and
-- attendance on the day has nowhere to live. `meetings` can't stand in: it
-- keys participants by email, and most students have no login at all.

create table if not exists programs (
  id                text primary key,
  title             text not null,
  category          text,               -- 'sports' | 'cultural' | 'academic' | 'competition' | 'excursion' | 'workshop' | 'celebration' | 'other'
  description       text,
  start_date        date not null,
  end_date          date,               -- null for a single-day event
  venue             text,
  organizer         text,               -- free-text name, kept even if the staff row goes
  -- Deliberately NOT a foreign key: staff are soft-deleted via archived_at,
  -- and a hard reference would block an archive/delete of a staff row that
  -- once organised an event years ago.
  organizer_staff_id text,
  audience          text,               -- 'school' | 'class' | 'selected' — how the roster was picked
  audience_label    text,               -- human label, e.g. "Classes VI–VIII"
  status            text default 'planned',   -- 'planned' | 'ongoing' | 'completed' | 'cancelled'
  budget_planned    int default 0,
  budget_actual     int default 0,
  outcome           text,               -- what actually happened, filled after the event
  notes             text,
  created_by        text references users(id),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- The screen lists by date and filters by status; without these both are
-- sequential scans from the first term the school runs this module.
create index if not exists idx_programs_start on programs (start_date desc);
create index if not exists idx_programs_status on programs (status, start_date desc);
alter table programs enable row level security;

create table if not exists program_participants (
  program_id  text not null,
  student_id  text not null references students(id) on delete cascade,
  role        text default 'participant',  -- 'participant' | 'winner' | 'volunteer' | 'captain' | ...
  attendance  text default 'pending',      -- 'pending' | 'present' | 'absent' | 'excused'
  result      text,                        -- free-text outcome, e.g. "1st — 100m"
  position    int,                         -- rank where the event is scored
  remarks     text,
  added_by    text,
  added_at    timestamptz default now(),
  primary key (program_id, student_id)
);

-- "Every program this child took part in" is the parent-facing read; the
-- composite primary key only covers the program_id direction.
create index if not exists idx_program_participants_student on program_participants (student_id);
alter table program_participants enable row level security;

-- Forward link so an achievement logged against a student can later be
-- traced back to the program that produced it. Nullable and unused by the
-- current code — present now so wiring it up is a data task, not a schema
-- change on a live database. Existing rows are NOT backfilled.
alter table student_activities add column if not exists program_id text;
