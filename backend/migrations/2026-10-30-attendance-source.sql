-- Staff attendance: where each mark came from, and a log of corrections.
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code.
-- Safe to run twice; every statement is idempotent. No existing row changes —
-- the new columns are nullable and stay null on rows written before this.
--
-- Why: the school asked "from where are staff marking their attendance". The
-- mark already recorded WHO (marked_by) and WHEN (marked_at), but not which
-- screen, and markTeacherAttendance upserts on (teacher_id, date) — so a
-- re-mark silently overwrote the previous value and no correction was ever
-- visible. marked_from answers the first question; teacher_attendance_log is
-- append-only and answers the second.
--
-- Deliberately NOT recorded: IP, device, geolocation. Which screen was used is
-- the limit of what the school needs; the rest would be surveillance.

alter table teacher_attendance add column if not exists marked_from text;  -- 'self' | 'admin' | 'exams-strip'

-- late_reason gets its own column. Both the leave note and the late note used
-- to share leave_reason, which made "why late" unqueryable. Old rows are NOT
-- backfilled; readers fall back to leave_reason when late_reason is null.
alter table teacher_attendance add column if not exists late_reason text;

create table if not exists teacher_attendance_log (
  id text primary key,
  teacher_id text not null,
  teacher_name text,
  date text not null,                 -- the day the attendance is FOR
  status text,
  previous_status text,               -- null on the first mark for that day
  leave_reason text,
  marked_by text,
  marked_by_id text,
  marked_from text,                   -- 'self' | 'admin' | 'exams-strip'
  marked_at timestamptz default now()
);

-- The provenance card reads one (teacher, date) history at a time, and the
-- admin list reads the most recent marks across everyone.
create index if not exists idx_teacher_attendance_log_who on teacher_attendance_log (teacher_id, date);
create index if not exists idx_teacher_attendance_log_at on teacher_attendance_log (marked_at desc);
alter table teacher_attendance_log enable row level security;
