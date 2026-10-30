-- Teacher salary / payroll — monthly pay runs and per-staff payslips.
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code.
-- Safe to run twice; every statement is idempotent. No existing row changes.
--
-- Why: staff.salary was a single int with no record of what was actually
-- paid, when, or why the amount differed from the contract figure. A school
-- that pays 18 teachers monthly needs the paid history to be queryable, and
-- needs paying the same month twice to be impossible.
--
-- The two decisions encoded in this schema:
--
-- 1. `unique (period)` on pay_runs. This is the double-pay guard. Without a
--    database constraint it becomes a UI check, and UI checks lose races.
--    (The JSON file-store fallback has no constraints, so createPayRunDraft
--    repeats the check in JS on that path.)
--
-- 2. payslips denormalises staff_name / staff_role / base_salary. A payslip
--    is a financial record of what was paid to whom under what title; it
--    must keep reading correctly after the staff row is renamed, re-graded
--    or archived. Joining live to staff would silently rewrite history.
--
-- attendance_source = 'unmatched' marks a run where staff→user email
-- resolution failed. Those payslips carry lop_days = 0 and full base salary:
-- underpaying a teacher because of a data-join failure is far worse than
-- overpaying, and the draft screen surfaces the count before finalise.

create table if not exists pay_runs (
  id               text primary key,
  period           text not null,              -- 'YYYY-MM'
  status           text not null default 'draft',  -- 'draft' | 'finalised'
  total_gross      int default 0,
  total_deductions int default 0,
  total_net        int default 0,
  staff_count      int default 0,
  working_days     int default 0,              -- editable per run; the LOP divisor
  expense_id       text,                       -- expenses.id, null until finalised
  notes            text,
  created_by       text,
  created_at       timestamptz default now(),
  finalised_at     timestamptz,
  finalised_by     text,
  unique (period)
);

create table if not exists payslips (
  id                text primary key,
  run_id            text not null,
  staff_id          text not null,
  staff_name        text,
  staff_role        text,
  period            text,
  base_salary       int default 0,
  present_days      int default 0,
  absent_days       int default 0,
  leave_days        int default 0,
  working_days      int default 0,
  lop_days          numeric default 0,
  lop_amount        int default 0,
  allowances        int default 0,
  deductions        int default 0,
  gross             int default 0,
  net               int default 0,
  attendance_source text default 'manual',     -- 'matched' | 'unmatched' | 'manual'
  notes             text,
  created_at        timestamptz default now(),
  unique (run_id, staff_id)
);

-- The run detail screen loads every payslip for one run; the staff history
-- view reads one teacher across periods. Without these both are table scans.
create index if not exists idx_payslips_run on payslips (run_id);
create index if not exists idx_payslips_staff on payslips (staff_id, period desc);
create index if not exists idx_pay_runs_period on pay_runs (period desc);

-- Added after the initial table in case an earlier copy of this migration
-- was applied before working_days became a stored, editable per-run field.
alter table pay_runs add column if not exists working_days int default 0;

alter table pay_runs enable row level security;
alter table payslips enable row level security;
