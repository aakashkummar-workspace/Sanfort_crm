-- Vidyalaya360 Supabase schema
-- Paste this whole file into the Supabase SQL editor and run it once.
-- Re-runnable: every statement is `if not exists`.

-- ---------- students ----------
-- Production rule: never hard-delete a student. The "Withdraw" action sets
-- status='archived' and stamps archived_at; their financial history (paid
-- receipts, audit log) is preserved forever. Restoring just clears the flag.
create table if not exists students (
  id text primary key,
  name text not null,
  cls text not null,
  parent text default '—',
  fee text default 'pending',
  attendance int default 0,
  transport text default '—',
  joined text,
  status text default 'active',
  archived_at timestamptz,
  created_at timestamptz default now()
);

-- For installs that ran an earlier schema, add the new columns idempotently.
alter table students add column if not exists status text default 'active';
alter table students add column if not exists archived_at timestamptz;
alter table students add column if not exists pickup_stop text;
alter table students add column if not exists height_cm numeric(6,2);
alter table students add column if not exists weight_kg numeric(6,2);
alter table students add column if not exists measured_at timestamptz;
create index if not exists idx_students_status on students (status);

-- ---------- pending fees ----------
-- One row per (student, fee-type) outstanding balance. `id` is composite —
-- "<student-id>__<fee-type>" — so a single student can carry multiple
-- pending items (Term I, Kit, Uniform, …) without clobbering each other.
-- `student_id` links back to the students table for joins; `fee_type` is
-- one of the FEE_TYPES keys (term1, term2, kit, …) and defaults to term1
-- so legacy single-fee inserts still land in a sensible bucket.
create table if not exists pending_fees (
  id text primary key,
  student_id text,
  name text,
  cls text,
  amount int,
  due text,
  overdue boolean default false,
  fee_type text default 'term1',
  created_at timestamptz default now()
);
-- Idempotent migration for older installs that pre-date the multi-fee
-- model — without these columns, every insert from the bulk-import / Add
-- Fee paths failed silently with "column does not exist".
alter table pending_fees add column if not exists student_id text;
alter table pending_fees add column if not exists fee_type text default 'term1';
create index if not exists idx_pending_fees_student on pending_fees (student_id);

-- ---------- recent (paid) fees ----------
-- One row per payment receipt. Multiple rows per student are allowed
-- (partial payments produce multiple receipts). The `id` is a unique
-- receipt id like "RCP-…"; `student_id` links back to the student row.
create table if not exists recent_fees (
  id text primary key,
  student_id text,
  name text,
  cls text,
  amount int,
  method text,
  time text,
  status text default 'paid',
  paid_at timestamptz default now()
);
-- Idempotent migration for older installs that had id=student_id.
alter table recent_fees add column if not exists student_id text;
create index if not exists idx_recent_fees_student on recent_fees (student_id);

-- ---------- complaints ----------
-- Tickets raised by parents (or staff). `type` distinguishes a regular
-- complaint from a leave-request submission; `submitted_by` records the role.
create table if not exists complaints (
  id text primary key,
  student text,
  student_id text,
  cls text,
  parent text,
  issue text,
  type text default 'general',          -- 'general' | 'leave_request'
  date text,
  status text default 'Open',           -- Open | In Progress | Resolved
  assigned text,
  submitted_by text default 'parent',   -- 'parent' | 'teacher' | 'principal'
  created_at timestamptz default now()
);
alter table complaints add column if not exists student_id text;
alter table complaints add column if not exists type text default 'general';
alter table complaints add column if not exists submitted_by text default 'parent';

-- ---------- enquiries ----------
create table if not exists enquiries (
  id text primary key,
  name text,
  parent text,
  phone text,
  cls int,
  source text,
  date text,
  status text default 'New',
  created_at timestamptz default now()
);

-- ---------- daily logs (composite key student + date) ----------
-- The Daily Monitoring Panel records what a teacher logs per student per day:
-- attendance + leave reason if absent, classwork/homework completion status,
-- handwriting feedback, behaviour and extra-curricular notes.
create table if not exists daily_logs (
  student_id text not null,
  date text not null,
  student_name text,
  cls text,
  attendance text default 'present',     -- 'present' | 'absent' | 'late' | 'leave' | 'parent_drop'
  leave_reason text,                     -- only filled when attendance='absent'
  classwork text,
  classwork_status text,                 -- 'completed' | 'not_completed' | null
  homework text,
  homework_status text,                  -- 'completed' | 'pending' | null
  subject_logs jsonb default '[]'::jsonb, -- per-subject CW/HW for the class
  topics text,
  handwriting_note text,
  handwriting_grade text,
  behaviour text,
  extra text,
  posted_by text,
  posted_at timestamptz default now(),
  primary key (student_id, date)
);
-- Idempotent ALTERs for installs that ran an earlier schema.
alter table daily_logs add column if not exists attendance text default 'present';
alter table daily_logs add column if not exists leave_reason text;
alter table daily_logs add column if not exists classwork_status text;
alter table daily_logs add column if not exists homework_status text;
alter table daily_logs add column if not exists subject_logs jsonb default '[]'::jsonb;

-- ---------- transport routes (stops as JSONB for flexibility) ----------
create table if not exists routes (
  code text primary key,
  name text,
  driver text,
  bus text,
  status text,
  eta text,
  stops jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

-- ---------- audit log ----------
create table if not exists audit_log (
  id text primary key,
  who text,
  action text,
  entity text,
  when_label text,        -- pre-formatted "08:42" / "Yesterday 18:14"
  ip text,
  created_at timestamptz default now()
);

-- ---------- classes + sections ----------
-- Configurable per school. Seeded with Class 1–8, sections A & B on first
-- install; safe to re-run — the INSERT uses ON CONFLICT DO NOTHING.
create table if not exists classes (
  n int primary key,
  label text,
  sections jsonb default '[]'::jsonb,
  subjects jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);
-- Safe re-run for older installs that already have `classes`.
alter table classes add column if not exists subjects jsonb default '[]'::jsonb;
insert into classes (n, label, sections) values
  (1, 'Class 1', '["A","B"]'::jsonb),
  (2, 'Class 2', '["A","B"]'::jsonb),
  (3, 'Class 3', '["A","B"]'::jsonb),
  (4, 'Class 4', '["A","B"]'::jsonb),
  (5, 'Class 5', '["A","B"]'::jsonb),
  (6, 'Class 6', '["A","B"]'::jsonb),
  (7, 'Class 7', '["A","B"]'::jsonb),
  (8, 'Class 8', '["A","B"]'::jsonb)
on conflict (n) do nothing;

-- ---------- activity feed ----------
create table if not exists activities (
  id bigserial primary key,
  t text,
  tone text,
  title text,
  sub text,
  ts text,
  created_at timestamptz default now()
);

-- ---------- helpful indexes ----------
create index if not exists idx_audit_created_at on audit_log (created_at desc);
create index if not exists idx_activities_created_at on activities (created_at desc);
create index if not exists idx_daily_logs_date on daily_logs (date desc);
create index if not exists idx_pending_fees_created_at on pending_fees (created_at desc);
create index if not exists idx_students_created_at on students (created_at desc);

-- ---------- donors ----------
-- One row per donor (CSR org, trust, individual, alumnus). `ytd` rolls up
-- contributions for the current year and is what drives the leaderboards.
create table if not exists donors (
  id text primary key,
  name text not null,
  type text default 'Individual',     -- 'CSR' | 'Trust' | 'Individual' | 'Alumni'
  email text,
  phone text,
  ytd int default 0,
  last_gift text,
  next_touchpoint text,
  archived_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_donors_type on donors (type);
alter table donors enable row level security;

-- campaigns: fundraising targets with progress % derived from raised/goal.
create table if not exists campaigns (
  id text primary key,
  name text not null,
  goal int default 0,
  raised int default 0,
  starts text,
  ends text,
  status text default 'active',       -- 'active' | 'completed' | 'paused'
  description text,
  created_at timestamptz default now()
);
alter table campaigns enable row level security;

-- ---------- communication ----------
-- broadcasts: log of every WhatsApp/SMS blast sent through the school
-- (manual or automation). sent/delivered counts feed the dashboard KPIs.
create table if not exists broadcasts (
  id text primary key,
  campaign text not null,
  channel text default 'whatsapp',         -- 'whatsapp' | 'sms' | 'both'
  audience text default 'all',             -- audience tag (e.g. 'all', 'pending_fees', 'class_5-A', 'list_xxx')
  audience_label text,                     -- human label shown in the table
  message text,
  sent int default 0,
  delivered int default 0,
  sent_at timestamptz default now()
);
create index if not exists idx_broadcasts_sent_at on broadcasts (sent_at desc);
alter table broadcasts enable row level security;

-- templates: re-usable DLT-approved message bodies with {{placeholders}}.
create table if not exists message_templates (
  id text primary key,
  name text not null,
  channel text default 'whatsapp',
  body text,
  created_at timestamptz default now()
);
alter table message_templates enable row level security;

-- recipient_lists: ad-hoc imported contact lists for one-off broadcasts
-- (e.g. "Class 5 picnic" parents). Contacts stored as a JSONB array of
-- { name, phone } objects.
create table if not exists recipient_lists (
  id text primary key,
  name text not null,
  contacts jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);
alter table recipient_lists enable row level security;

-- ---------- inventory ----------
-- Stock register for books / uniforms / assets. on_hand (Balance) is the
-- live source of truth; qty_purchased / issued track lifetime totals via
-- inventory_movements.
create table if not exists inventory (
  id text primary key,
  name text not null,
  category text default 'asset',     -- 'book' | 'uniform' | 'asset' | custom
  cls text,                          -- '5-A' / 'all' / null
  description text,
  storage_location text,
  on_hand numeric default 0,         -- Balance Stock
  min numeric default 0,             -- Reorder Level
  issued numeric default 0,          -- Qty Issued / Used (lifetime)
  qty_purchased numeric default 0,   -- Qty Purchased (lifetime)
  unit_price numeric default 0,
  supplier text,
  archived_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_inventory_category on inventory (category);
-- Free-text remarks per item (condition notes, specifications, etc.). Added
-- after the initial release, so guard it for existing installs.
alter table inventory add column if not exists remarks text;
alter table inventory enable row level security;

create table if not exists inventory_movements (
  id text primary key,
  item_id text not null,
  type text not null,                -- 'in' | 'out'
  qty numeric not null,
  note text,
  issued_to text,                    -- Issued To / Dept (stock-out)
  who text,
  at timestamptz default now()
);
create index if not exists idx_inv_movements_at on inventory_movements (at desc);
alter table inventory_movements enable row level security;

-- ---------- staff ----------
-- One row per teacher / ops / intern on the school's payroll. Performance
-- numbers (attendance, tasks, score) are pre-aggregated per month so the
-- dashboard reads stay cheap. Soft-delete via archived_at.
create table if not exists staff (
  id text primary key,
  name text not null,
  role text default 'Teacher',          -- 'Teacher' | 'Ops' | 'Intern'
  dept text default '—',
  phone text default '—',
  email text,
  joining_date text,
  salary int default 0,
  attendance int default 0,             -- this month % present
  tasks int default 0,                  -- this month % tasks done
  score int default 0,                  -- composite (set by trigger or app)
  status text default 'ok',             -- 'top' | 'ok' | 'low'
  avatar text,                          -- 2-char initials for chip
  archived_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_staff_role on staff (role);
alter table staff enable row level security;

-- ---------- users (auth) ----------
-- One row per real human who can sign in. Passwords are bcrypt-hashed before
-- storage; the raw password never reaches the database. `role` controls which
-- screens the session can see. `linked_id` ties a parent account to one
-- student row (so the parent dashboard scopes to that child) or a teacher
-- account to one staff row.
create table if not exists users (
  id text primary key,
  email text unique not null,
  password_hash text not null,
  role text not null,        -- 'admin' | 'academic_director' | 'principal' | 'teacher' | 'parent'
  name text not null,
  linked_id text,            -- student_id (parent) or staff_id (teacher), nullable
  created_at timestamptz default now()
);
create index if not exists idx_users_role on users (role);
alter table users enable row level security;

-- ---------- tasks ----------
-- Lightweight assignment system. Admin creates tasks; assignee answers Yes/No
-- with optional remarks. status stays in sync: yes→done, no/awaiting→pending.
create table if not exists tasks (
  id text primary key,
  title text not null,
  description text,
  assigned_to text,                  -- user id
  assigned_to_name text,
  assigned_to_role text,
  assigned_by text,
  assigned_by_name text,
  status text default 'pending',     -- 'pending' | 'in_progress' | 'done'
  priority text default 'normal',    -- 'low' | 'normal' | 'high' | 'urgent'
  due_date text,
  response text,                     -- null | 'yes' | 'no' (assignee answer)
  remarks text,                      -- assignee notes on the task status
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_tasks_assigned_to on tasks (assigned_to);
create index if not exists idx_tasks_status on tasks (status);
alter table tasks add column if not exists response text;
alter table tasks add column if not exists remarks text;
alter table tasks enable row level security;

-- ---------- meetings + RSVPs ----------
-- Audience can be "all", "class:X-Y" or "user:email". RSVPs live in their own
-- table so a single meeting can have many parents respond independently.
create table if not exists meetings (
  id text primary key,
  title text not null,
  description text,
  scheduled_at text,                 -- ISO timestamp
  location text default 'School premises',
  audience text default 'all',
  audience_label text,
  created_by_email text,
  created_by_name text,
  created_at timestamptz default now()
);
create index if not exists idx_meetings_scheduled on meetings (scheduled_at);
alter table meetings enable row level security;

create table if not exists meeting_rsvps (
  meeting_id text not null,
  from_email text not null,
  from_name text,
  response text default 'maybe',     -- 'yes' | 'no' | 'maybe'
  responded_at timestamptz default now(),
  primary key (meeting_id, from_email)
);
alter table meeting_rsvps enable row level security;

-- ---------- volunteers + hours ----------
create table if not exists volunteers (
  id text primary key,
  name text not null,
  email text,
  phone text,
  skills jsonb default '[]'::jsonb,
  availability text default 'weekends',
  notes text,
  hours int default 0,
  archived_at timestamptz,
  created_at timestamptz default now()
);
alter table volunteers enable row level security;

create table if not exists volunteer_hours (
  id text primary key,
  volunteer_id text not null,
  hours int default 0,
  activity text default '—',
  date text,
  created_at timestamptz default now()
);
create index if not exists idx_volunteer_hours_vid on volunteer_hours (volunteer_id);
alter table volunteer_hours enable row level security;

-- ---------- chat threads + messages ----------
-- Threads are keyed by `parentEmail::teacherEmail::studentId` so a parent
-- talking to multiple teachers about the same kid keeps threads separate.
create table if not exists chat_threads (
  id text primary key,
  parent_email text,
  parent_name text,
  teacher_email text,
  teacher_name text,
  student_id text,
  student_name text,
  cls text,
  created_at timestamptz default now(),
  last_message_at timestamptz
);
create index if not exists idx_chat_threads_parent on chat_threads (parent_email);
create index if not exists idx_chat_threads_teacher on chat_threads (teacher_email);
alter table chat_threads enable row level security;

create table if not exists chat_messages (
  id text primary key,
  thread_id text not null,
  from_email text,
  from_name text,
  from_role text,
  body text not null,
  sent_at timestamptz default now()
);
create index if not exists idx_chat_messages_thread on chat_messages (thread_id, sent_at);
alter table chat_messages enable row level security;

-- ---------- transfer certificates ----------
create table if not exists tc_requests (
  id text primary key,
  student_id text not null,
  student_name text,
  cls text,
  reason text,
  status text default 'requested',  -- 'requested' | 'approved' | 'issued' | 'rejected'
  requested_by text,
  requested_at timestamptz default now(),
  issued_at timestamptz,
  issued_by text,
  serial_no text
);
create index if not exists idx_tc_requests_status on tc_requests (status);
alter table tc_requests enable row level security;

-- ---------- subjects ----------
-- Manageable list of subjects taught at the school. Used as the source
-- of truth for the Timetable dropdown and the Exams & Marks subject
-- picker. Seeded with the common Indian school set on first run; safe
-- to re-run because of ON CONFLICT DO NOTHING.
create table if not exists subjects (
  id text primary key,
  name text not null unique,
  code text,
  category text default 'core',     -- 'core' | 'language' | 'activity' | 'optional'
  created_at timestamptz default now()
);
insert into subjects (id, name, category) values
  ('SUB-ENG', 'English',         'language'),
  ('SUB-TAM', 'Tamil',           'language'),
  ('SUB-HIN', 'Hindi',           'language'),
  ('SUB-MAT', 'Maths',           'core'),
  ('SUB-SCI', 'Science',         'core'),
  ('SUB-SST', 'Social Science',  'core'),
  ('SUB-PT',  'PT',              'activity')
on conflict (id) do nothing;
alter table subjects enable row level security;

-- ---------- staff awards / recognition ----------
-- One row per award (Teacher of the Month, Perfect Attendance, etc).
-- Awards are immutable once issued — to revoke, delete the row. The
-- citation field is freeform so principals can write context.
create table if not exists staff_awards (
  id text primary key,
  staff_id text not null,
  staff_name text,
  title text not null,
  citation text,
  category text default 'recognition',  -- 'recognition' | 'attendance' | 'academic' | 'service'
  awarded_at text,                       -- 'Apr 2026' display string
  awarded_by text,
  created_at timestamptz default now()
);
create index if not exists idx_staff_awards_staff on staff_awards (staff_id);
alter table staff_awards enable row level security;

-- ---------- transport attendance ----------
-- One row per (student_id, date, direction). Records whether a student
-- actually boarded the bus on a given trip. Stop counters on the route
-- stay aggregate; this table is the per-student detail used by the
-- Transport history page.
create table if not exists transport_attendance (
  student_id   text not null,
  date         text not null,
  direction    text not null default 'morning',  -- 'morning' | 'evening'
  route_code   text,
  stop_name    text,
  status       text not null default 'boarded',  -- 'boarded' | 'absent' | 'skipped' | 'dropped' | 'parent'
  student_name text,
  cls          text,
  marked_by    text,
  marked_at    timestamptz default now(),
  primary key (student_id, date, direction)
);
create index if not exists idx_transport_attendance_date on transport_attendance (date desc);
create index if not exists idx_transport_attendance_route on transport_attendance (route_code, date desc);
alter table transport_attendance enable row level security;

-- ---------- teacher attendance ----------
-- One row per (teacher_id, date). Self-marked, can be overridden by admins.
create table if not exists teacher_attendance (
  id text primary key,
  teacher_id text not null,
  teacher_name text,
  date text not null,
  status text default 'present',     -- 'present' | 'absent' | 'leave'
  leave_reason text,
  marked_by text,
  marked_at timestamptz default now(),
  unique (teacher_id, date)
);
create index if not exists idx_teacher_attendance_date on teacher_attendance (date desc);
alter table teacher_attendance enable row level security;

-- ---------- exams + marks ----------
create table if not exists exams (
  id text primary key,
  name text not null,
  type text default 'unit_test',     -- unit_test | mid_term | final | assignment | practical | project
  cls text not null,
  subject text not null,
  max_marks int default 100,
  date text,
  created_by text,
  created_at timestamptz default now()
);
create index if not exists idx_exams_cls_subject on exams (cls, subject);
alter table exams enable row level security;

create table if not exists exam_marks (
  id text primary key,
  exam_id text not null,
  student_id text not null,
  student_name text,
  score int default 0,
  max_marks int default 100,
  remarks text,
  recorded_by text,
  recorded_at timestamptz default now(),
  unique (exam_id, student_id)
);
create index if not exists idx_exam_marks_exam on exam_marks (exam_id);
create index if not exists idx_exam_marks_student on exam_marks (student_id);
alter table exam_marks enable row level security;

-- ---------- bus maintenance ----------
create table if not exists maintenance_logs (
  id text primary key,
  bus_number text not null,
  route_code text,
  type text default 'service',        -- service | fuel | insurance | FC | PUC | repair | tyre | battery
  date text,
  odometer int,
  vendor text,
  cost int default 0,
  notes text,
  next_due_date text,
  recorded_by text,
  created_at timestamptz default now()
);
create index if not exists idx_maintenance_bus on maintenance_logs (bus_number);
alter table maintenance_logs enable row level security;

-- ---------- expenses ----------
create table if not exists expenses (
  id text primary key,
  scope text default 'school',        -- 'school' | 'trust'
  category text default 'Misc',
  amount int default 0,
  vendor text,
  memo text,
  date text,
  payment_method text default 'Bank transfer',
  recorded_by text,
  created_at timestamptz default now()
);
create index if not exists idx_expenses_scope on expenses (scope);
alter table expenses enable row level security;

-- ---------- documents ----------
-- Generic file attachments. data_url stores the base64 preview inline (good
-- for demo-sized files; swap to object storage in prod).
create table if not exists documents (
  id text primary key,
  entity_type text not null,          -- 'student' | 'staff' | 'volunteer' | 'tc'
  entity_id text not null,
  label text,
  file_name text,
  mime_type text default 'application/octet-stream',
  data_url text,
  size_bytes int default 0,
  uploaded_by text,
  uploaded_at timestamptz default now()
);
create index if not exists idx_documents_entity on documents (entity_type, entity_id);
alter table documents enable row level security;

-- ---------- donation receipts ----------
-- Per-donation ledger. Each row is one 80G-style receipt; donors.ytd is the
-- rolled-up sum across all receipts.
create table if not exists donor_receipts (
  id text primary key,
  donor_id text not null,
  donor_name text,
  donor_type text,
  amount int default 0,
  method text default 'Bank transfer',
  memo text,
  campaign_id text,
  issued_at timestamptz default now(),
  issued_at_label text
);
create index if not exists idx_donor_receipts_donor on donor_receipts (donor_id);
alter table donor_receipts enable row level security;

-- ---------- role permissions ----------
-- One row per (role, feature_id). Missing rows default to allowed in the app.
-- Admin's "locked-on" features (access, dashboard, trust, settings) are
-- enforced in code regardless of what's stored here.
create table if not exists role_permissions (
  role text not null,
  feature_id text not null,
  allowed boolean default true,
  updated_at timestamptz default now(),
  primary key (role, feature_id)
);
alter table role_permissions enable row level security;

-- ---------- schools (trust-level multi-school) ----------
create table if not exists schools (
  id text primary key,
  name text not null,
  city text,
  status text default 'Active',
  students int default 0,
  fees int default 0,             -- 0–100 % collected
  wellness text,
  puck text,                      -- styling token
  archived_at timestamptz,
  created_at timestamptz default now()
);
alter table schools enable row level security;

-- ---------- app settings ----------
-- Generic key/value bag for trust-wide configuration (Trust identity, finance
-- defaults, comms providers, security). Keyed by (section, key).
create table if not exists app_settings (
  section text not null,
  key text not null,
  value text,
  updated_at timestamptz default now(),
  primary key (section, key)
);
alter table app_settings enable row level security;

-- ---------- automation ----------
-- Event → action rules + a per-rule run log so the dashboard can show success
-- rate and last-fired info.
create table if not exists automation_rules (
  id text primary key,
  name text not null,
  event text,
  action text,
  config jsonb default '{}'::jsonb,
  enabled boolean default true,
  runs int default 0,
  last_fired_at timestamptz,
  last_status text,                  -- 'ok' | 'err' | null
  created_at timestamptz default now()
);
alter table automation_rules enable row level security;

create table if not exists automation_runs (
  id text primary key,
  rule_id text not null,
  success boolean default true,
  message text,
  fired_at timestamptz default now()
);
create index if not exists idx_automation_runs_rule on automation_runs (rule_id, fired_at desc);
alter table automation_runs enable row level security;

-- ---------- broadcast recipients ----------
-- Per-recipient delivery row so we can answer "did Mrs Khan get the dues
-- reminder?". One row per (broadcast, contact_phone).
create table if not exists broadcast_recipients (
  id text primary key,
  broadcast_id text not null,
  contact_name text,
  contact_phone text,
  status text default 'sent',         -- 'sent' | 'delivered' | 'failed'
  sent_at timestamptz default now(),
  delivered_at timestamptz
);
create index if not exists idx_broadcast_recipients_bid on broadcast_recipients (broadcast_id);
alter table broadcast_recipients enable row level security;

-- ---------- Row Level Security ----------
-- This app uses the SUPABASE_SERVICE_ROLE_KEY on the server, so RLS doesn't
-- need to allow anonymous reads. Enable RLS so the anon key can't write
-- by accident; the service role bypasses RLS.
alter table students      enable row level security;
alter table pending_fees  enable row level security;
alter table recent_fees   enable row level security;
alter table complaints    enable row level security;
alter table enquiries     enable row level security;
alter table daily_logs    enable row level security;
alter table routes        enable row level security;
alter table audit_log     enable row level security;
alter table activities    enable row level security;
alter table classes       enable row level security;

-- ---------- timetable ----------
-- One row per (class, day, period) slot. id is composite-derived so that
-- re-saving the same slot via upsert replaces the previous assignment
-- without leaving orphan rows. teacher_id references staff(id) loosely
-- (no FK so deleting a teacher won't cascade-delete history).
create table if not exists timetable (
  id           text primary key,           -- "TT-{cls}-{day}-{period}"
  cls          text not null,              -- '1-A', '5-B', ...
  day          text not null,              -- 'Mon' .. 'Sat'
  period       int  not null,              -- 1 .. 7
  subject      text not null,
  teacher_id   text,
  teacher_name text,
  room         text,
  updated_at   timestamptz default now()
);
create index if not exists idx_timetable_cls     on timetable (cls);
create index if not exists idx_timetable_teacher on timetable (teacher_id);
alter table timetable enable row level security;

-- ---------- library: books ----------
-- Catalog of titles in the school library. `total_copies` is the number of
-- physical books on the shelf; `available` is derived (total minus active
-- loans) so the count never drifts.
create table if not exists library (
  id           text primary key,
  title        text not null,
  author       text,
  category     text default 'general',     -- 'fiction' | 'textbook' | 'reference' | …
  isbn         text,
  shelf        text,
  total_copies int default 1,
  added_at     timestamptz default now()
);
create index if not exists idx_library_category on library (category);
create index if not exists idx_library_title    on library (title);
alter table library enable row level security;

-- ---------- library: loans ----------
-- One row per checkout. returned_at = null means the book is still out.
-- borrower_type distinguishes student vs teacher/staff so the dashboards
-- can scope each user's "my borrowed books" view correctly.
create table if not exists library_loans (
  id            text primary key,
  book_id       text not null,
  book_title    text,
  borrower_type text not null,             -- 'student' | 'teacher' | 'staff'
  borrower_id   text not null,
  borrower_name text,
  borrowed_at   timestamptz default now(),
  due_at        timestamptz,
  returned_at   timestamptz,
  issued_by     text,
  returned_by   text
);
create index if not exists idx_library_loans_book   on library_loans (book_id);
create index if not exists idx_library_loans_active on library_loans (returned_at) where returned_at is null;
create index if not exists idx_library_loans_borrower on library_loans (borrower_type, borrower_id);
alter table library_loans enable row level security;

-- ---------- inventory: saved categories ----------
-- Custom category names the school adds via the "Save category" button on
-- the Inventory screen. Built-in buckets (book/uniform/asset) don't need a
-- row here — anything in this table is a school-defined extra.
create table if not exists inventory_categories (
  key        text primary key,             -- slugged: 'stationery', 'lab', ...
  created_at timestamptz default now()
);
alter table inventory_categories enable row level security;

-- ---------- syllabus ----------
-- One row per topic/lesson within a class section. Bulk-imported from an
-- Excel file (Class | Subject | Chapter | Topic | Term | Week | Notes) on
-- the Syllabus screen. cls is the composite '5-A' / '12-C' string used by
-- timetable + attendance, so a class teacher can filter their own section
-- without joining a classes table.
create table if not exists syllabus (
  id        text primary key,            -- 'SYL-<random>'
  cls       text not null,               -- '1-A', '12-C'
  subject   text not null,
  chapter   text,
  topic     text not null,
  term      int,                         -- 1..4
  week_no   int,                         -- 1..60 (school year weeks)
  notes     text,
  added_at  timestamptz default now(),
  added_by  text
);
create index if not exists idx_syllabus_cls     on syllabus (cls);
create index if not exists idx_syllabus_subject on syllabus (subject);
alter table syllabus enable row level security;

-- =====================================================================
-- v2 expansion: roles, permissions, finance roles, parent↔admin chat,
-- public donor form, student activities, remarks/rewards, government
-- documents, notifications, leave requests. Every block below is fully
-- idempotent (`if not exists`) so this file can be re-run on an
-- existing install without touching the v1 data.
-- =====================================================================

-- ---------- roles (canonical) -------------------------------------------
-- The five seeded roles ('admin', 'academic_director', 'principal',
-- 'teacher', 'parent') plus the two new finance roles
-- ('school_accountant', 'trust_accountant'). Lives in the DB so admins
-- can edit descriptions / labels without a code push.
create table if not exists roles (
  id          text primary key,            -- machine name: 'school_accountant'
  role_name   text not null,               -- display label: 'School Accountant'
  description text,
  is_system   boolean default false,       -- true for the seeded canonical 7
  created_at  timestamptz default now()
);
alter table roles enable row level security;

-- ---------- user_permissions (per-user feature toggles) -----------------
-- Per-feature override on top of role defaults. Used when an admin wants
-- one specific user to deviate from their role's defaults (e.g. a
-- principal who shouldn't see the audit log).
-- access_level: 'none' | 'view' | 'edit' | 'admin'
create table if not exists user_permissions (
  id           text primary key,
  user_id      text not null references users(id) on delete cascade,
  feature_name text not null,
  access_level text not null default 'view',
  created_at   timestamptz default now(),
  unique (user_id, feature_name)
);
create index if not exists idx_user_permissions_user on user_permissions (user_id);
alter table user_permissions enable row level security;

-- ---------- custom_roles + role_feature_access ---------------------------
-- Admin-defined roles created at runtime via the Users & Roles screen.
-- Each custom role gets a row in custom_roles, and one row per feature
-- in role_feature_access. The Sidebar reads this table to decide
-- visibility for users whose role string matches a custom_roles.id.
create table if not exists custom_roles (
  id          text primary key,            -- 'role-mid-office'
  role_name   text not null,
  created_by  text references users(id),
  created_at  timestamptz default now()
);
alter table custom_roles enable row level security;

create table if not exists role_feature_access (
  id           text primary key,
  role_id      text not null references custom_roles(id) on delete cascade,
  feature_name text not null,              -- 'students', 'fees', 'audit', ...
  can_view     boolean default true,
  can_edit     boolean default false,
  can_delete   boolean default false,
  unique (role_id, feature_name)
);
create index if not exists idx_role_feature_access_role on role_feature_access (role_id);
alter table role_feature_access enable row level security;

-- ---------- expense_categories ------------------------------------------
-- Custom expense categories admins add via the "Add Category" button on
-- the Money / Expenses screen. category_type splits school vs trust so
-- the two new finance roles see only the categories they own.
create table if not exists expense_categories (
  id            text primary key,
  category_name text not null,
  category_type text not null default 'school',  -- 'school' | 'trust'
  created_by    text references users(id),
  created_at    timestamptz default now()
);
create index if not exists idx_expense_categories_type on expense_categories (category_type);
alter table expense_categories enable row level security;

-- Wire existing expenses to a category when one is chosen. Keeps the
-- legacy free-text 'category' column for back-compat.
alter table expenses add column if not exists category_id text references expense_categories(id);
create index if not exists idx_expenses_category on expenses (category_id);

-- Inventory ↔ Expense linkage. When an inventory item is added with a
-- non-zero unit price * quantity, the backend cascades into a real
-- expense row stamped with the source inventory id so the Money screen
-- can show a "Inventory purchase" badge and a link back to the item.
alter table expenses add column if not exists inventory_id text references inventory(id) on delete set null;
create index if not exists idx_expenses_inventory on expenses (inventory_id);

-- ---------- messages (parent ↔ admin DM stream) -------------------------
-- Replaces the parent ↔ teacher chat for general queries. Teacher chat
-- still exists for academic-context messages; this table is for
-- parent-to-admin grievance / admin-to-parent broadcasts.
create table if not exists messages (
  id            text primary key,
  sender_id     text not null references users(id) on delete cascade,
  receiver_id   text not null references users(id) on delete cascade,
  sender_role   text not null,
  receiver_role text not null,
  message       text not null,
  is_read       boolean default false,
  created_at    timestamptz default now()
);
create index if not exists idx_messages_receiver on messages (receiver_id, is_read);
create index if not exists idx_messages_pair     on messages (sender_id, receiver_id, created_at desc);
alter table messages enable row level security;

-- ---------- donor_form_submissions (public /donorform endpoint) ---------
-- A donor lands on /donorform from the school's marketing site, fills
-- in their details, and we insert a row here. Admin sees a
-- "Donor Submissions" widget on the dashboard; clicking accept inserts
-- a real donor record + receipt and flips status to 'accepted'.
-- status: 'pending' | 'accepted' | 'rejected'
create table if not exists donor_form_submissions (
  id              text primary key,
  donor_name      text not null,
  phone           text,
  email           text,
  donation_type   text,                    -- 'one_time' | 'monthly' | 'annual'
  donation_amount numeric(12,2),
  message         text,
  status          text default 'pending',
  submitted_at    timestamptz default now()
);
create index if not exists idx_donor_form_status on donor_form_submissions (status, submitted_at desc);
alter table donor_form_submissions enable row level security;

-- ---------- student_activities (extra-curricular log) -------------------
-- Sports, debates, science fair, external competitions etc. Linked to a
-- student so the Reports → student-detail view can show a chronological
-- list of achievements. external_competition is true when the event is
-- run by a body outside the school (district / state / national).
create table if not exists student_activities (
  id                   text primary key,
  student_id           text not null references students(id) on delete cascade,
  activity_name        text not null,
  event_name           text,
  achievement_level    text,               -- 'participation' | 'winner' | 'runner_up' | ...
  external_competition boolean default false,
  activity_link        text,               -- URL to event page / news story
  certificate_document text,               -- file URL, references documents.id
  activity_date        date,
  created_by           text references users(id),
  created_at           timestamptz default now()
);
create index if not exists idx_student_activities_student on student_activities (student_id, activity_date desc);
alter table student_activities enable row level security;

-- ---------- remarks_rewards (admin notes on students/teachers) ----------
-- A unified ledger for both positive (reward) and negative (remark)
-- entries against a student or teacher. action_taken records what the
-- admin did about it (e.g. "called parent", "letter of appreciation").
create table if not exists remarks_rewards (
  id           text primary key,
  target_type  text not null,              -- 'student' | 'teacher'
  target_id    text not null,
  type         text not null,              -- 'reward' | 'remark'
  category     text,                       -- 'discipline' | 'academic' | 'sports' | ...
  description  text not null,
  action_taken text,
  created_by   text references users(id),
  created_at   timestamptz default now()
);
create index if not exists idx_remarks_rewards_target on remarks_rewards (target_type, target_id, created_at desc);
alter table remarks_rewards enable row level security;

-- Resolution metadata — added so a remark logged against a student or
-- teacher can be marked "handled" by an admin/principal without
-- destroying the audit trail. Idempotent so re-running this file is safe.
alter table remarks_rewards add column if not exists resolved_at      timestamptz;
alter table remarks_rewards add column if not exists resolved_by      text references users(id);
alter table remarks_rewards add column if not exists resolution_note  text;

-- ---------- government_documents (admin-only vault) ---------------------
-- Trust registration certs, 80G, 12A, building NOC, fire safety, etc.
-- expiry_date powers the "Government Document Alerts" dashboard widget;
-- a daily cron flips approaching docs into a notification.
create table if not exists government_documents (
  id            text primary key,
  title         text not null,
  document_type text,                       -- 'registration' | '80g' | '12a' | 'noc' | ...
  file_url      text,
  expiry_date   date,
  uploaded_by   text references users(id),
  notes         text,
  created_at    timestamptz default now()
);
create index if not exists idx_gov_docs_expiry on government_documents (expiry_date);
alter table government_documents enable row level security;

-- ---------- notifications (in-app real-time alerts) ---------------------
-- Generic notification stream consumed by the topbar bell + the
-- per-screen popover. notification_type drives the icon and sort order.
-- redirect_url is a relative path the bell click navigates to (e.g.
-- '/messages?from=USR-PARENT-12').
create table if not exists notifications (
  id                text primary key,
  user_id           text not null references users(id) on delete cascade,
  notification_type text not null,         -- 'parent_message' | 'donor_form' | 'leave_request' | 'gov_doc_expiry' | ...
  title             text not null,
  description       text,
  redirect_url      text,
  is_read           boolean default false,
  created_at        timestamptz default now()
);
create index if not exists idx_notifications_user_unread on notifications (user_id, is_read, created_at desc);
alter table notifications enable row level security;

-- ---------- leave_requests (students + teachers) ------------------------
-- Workflow: requester submits → admin/principal approves or rejects →
-- status flips. For students, the linked attendance row for the date
-- range is auto-marked 'leave' on approval.
-- approval_status: 'pending' | 'approved' | 'rejected' | 'cancelled'
-- requester_type:  'student' | 'teacher'
create table if not exists leave_requests (
  id              text primary key,
  requester_type  text not null,
  requester_id    text not null,
  leave_type      text,                     -- 'sick' | 'casual' | 'planned' | 'family' | ...
  reason          text,
  from_date       date not null,
  to_date         date not null,
  approval_status text default 'pending',
  approved_by     text references users(id),
  approved_at     timestamptz,
  created_at      timestamptz default now()
);
create index if not exists idx_leave_requests_status on leave_requests (approval_status, created_at desc);
create index if not exists idx_leave_requests_requester on leave_requests (requester_type, requester_id);
alter table leave_requests enable row level security;

-- ---------- seed the canonical roles row --------------------------------
-- Idempotent insert so re-runs don't duplicate. The two new finance
-- roles are appended; existing five stay as-is.
insert into roles (id, role_name, description, is_system) values
  ('admin',              'Admin',              'Full school + trust access',                    true),
  ('academic_director',  'Academic Director',  'Academics: attendance, daily logs, exams',      true),
  ('principal',          'Principal',          'School operations: fees, staff, ops, comms',    true),
  ('teacher',            'Teacher',            'Assigned classroom only',                       true),
  ('parent',             'Parent',             'Their child''s read-only view',                  true),
  ('school_accountant',  'School Accountant',  'School finance: fees, school expenses, ledger', true),
  ('trust_accountant',   'Trust Accountant',   'Trust finance: donations, trust expenses',      true)
on conflict (id) do update
  set role_name   = excluded.role_name,
      description = excluded.description,
      is_system   = excluded.is_system;

-- =====================================================================
-- SCALE — Student Competency and Activity Ledger for Education
-- 4 domains × 4 indicators each, scored 1-4 per session, rolled up
-- to a 100-point composite. See backend/lib/scale.js for the indicator
-- seed and weights — DB tables here are persistence only.
-- =====================================================================

-- ---------- scale_sessions ----------------------------------------------
-- One row per staff lesson session. Stores the staff checklist payload
-- (pre / during / post / sign-off) as JSON so the schema doesn't have
-- to mirror every checkbox; the screen knows the shape.
create table if not exists scale_sessions (
  id              text primary key,
  teacher_id      text references users(id),
  cls             text,                       -- "2-A"
  subject         text,
  session_date    date not null,
  session_type    text default 'regular',     -- 'regular' | 'remedial' | 'special'
  students_present int default 0,
  pre_checklist   jsonb default '{}'::jsonb,  -- { lessonPlan: bool, ... }
  during_ratings  jsonb default '{}'::jsonb,  -- { objectiveCommunicated: 1..4, ... }
  post_ratings    jsonb default '{}'::jsonb,
  worked_well     text,
  to_change       text,
  signoff         jsonb default '{}'::jsonb,
  notes           text,
  created_at      timestamptz default now()
);
create index if not exists idx_scale_sessions_teacher on scale_sessions (teacher_id, session_date desc);
create index if not exists idx_scale_sessions_cls     on scale_sessions (cls, session_date desc);
alter table scale_sessions enable row level security;

-- ---------- scale_entries -----------------------------------------------
-- Per (session, student, indicator) score 1-10 (per indicator scale) plus optional one-line note.
-- The composite report aggregates these by student over a date range or term.
create table if not exists scale_entries (
  id            text primary key,
  session_id    text references scale_sessions(id) on delete cascade,
  student_id    text not null references students(id) on delete cascade,
  indicator_key text not null,                -- 'A.lesson_test', 'E.handwriting', ...
  score         int not null check (score between 1 and 10),
  note          text,
  created_at    timestamptz default now()
);
create index if not exists idx_scale_entries_student on scale_entries (student_id, created_at desc);
create index if not exists idx_scale_entries_session on scale_entries (session_id);
create index if not exists idx_scale_entries_indicator on scale_entries (indicator_key);
alter table scale_entries enable row level security;

-- ---------- scale_support_plans ----------------------------------------
-- Sequenced weaker-student support workflow. Each step has its own
-- column so the screen can enforce ordering: step 4 (strength-first)
-- and step 5 (therapy referral) can only be filled after step 1
-- (root cause) and step 2 (domain advisory) are documented.
-- status: 'active' | 'closed' | 'escalated'
create table if not exists scale_support_plans (
  id              text primary key,
  student_id      text not null references students(id) on delete cascade,
  term            text default 'all',           -- 'all' | '1' | '2' | '3'
  current_step    int  default 1,
  root_cause      jsonb default '{}'::jsonb,    -- { category, hypothesis, observed }
  domain_advisory jsonb default '{}'::jsonb,    -- { weakIndicators: [...], actions: [...] }
  strength_plan   jsonb default '{}'::jsonb,    -- { strongIndicators: [...], schedulingNotes }
  referral        jsonb default '{}'::jsonb,    -- { specialistType, reason, referredAt }
  status          text default 'active',
  created_by      text references users(id),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index if not exists idx_scale_support_student on scale_support_plans (student_id, status);
alter table scale_support_plans enable row level security;

-- ---------- scale_daily_rituals -----------------------------------------
-- Student's 2-minute daily closing ritual — three questions answered at
-- end of school day. Used on the parent's phone (since the student
-- usually doesn't have one). One row per student per date.
create table if not exists scale_daily_rituals (
  id            text primary key,
  student_id    text not null references students(id) on delete cascade,
  ritual_date   date not null,
  q1_learned    text,                            -- "what did you learn today"
  q2_did_well   text,                            -- "what did you do well"
  q3_tomorrow   text,                            -- "what will you try tomorrow"
  recorded_by   text references users(id),
  created_at    timestamptz default now(),
  unique (student_id, ritual_date)
);
create index if not exists idx_scale_rituals_student on scale_daily_rituals (student_id, ritual_date desc);
alter table scale_daily_rituals enable row level security;
