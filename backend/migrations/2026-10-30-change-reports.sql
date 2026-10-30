-- In-app change reports: bugs and change requests filed from any screen.
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code.
-- Safe to run twice. Creates one new table; changes nothing existing.
--
-- The screenshot BYTES are not stored here. `screenshot_file` holds a
-- filename under MEDIA_ROOT/change-reports (see backend/lib/media.js), which
-- is outside the public directory and served only through an authenticated
-- endpoint. A screenshot of a fees or student page contains real personal
-- data about a child and their family; anything written to a statically
-- served folder is readable by anyone who guesses the name.
--
-- `expected_behaviour` is what separates a defect from a change request:
-- without it, "the total is wrong" cannot be told apart from "the total is
-- right but we want it calculated differently".

create table if not exists change_reports (
  id                  text primary key,
  report_type         text not null,            -- bug | logic_change | new_feature | ui_issue | data_issue | performance
  severity            text not null default 'major',  -- blocking | major | minor
  title               text not null,
  description         text not null,
  expected_behaviour  text,

  -- Captured automatically; the reporter never types these.
  page_url            text,
  page_route          text,
  browser_info        text,
  screen_size         text,
  screenshot_file     text,

  -- Triage.
  status              text not null default 'new',    -- new | acknowledged | in_progress | fixed | wont_fix | duplicate
  assigned_to_id      text,
  assigned_to_name    text,
  resolution_notes    text,
  resolved_at         timestamptz,

  reporter_id         text,
  reporter_name       text,
  reporter_role       text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index if not exists idx_cr_reporter on change_reports (reporter_id);
create index if not exists idx_cr_status   on change_reports (status);
create index if not exists idx_cr_type     on change_reports (report_type);
create index if not exists idx_cr_created  on change_reports (created_at desc);

alter table change_reports enable row level security;
