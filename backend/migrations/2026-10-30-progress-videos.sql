-- Monthly student progress videos.
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code.
-- Safe to run twice. Creates one new table; changes nothing existing.
--
-- The video BYTES are never stored here. This table holds metadata and a
-- `storage_key` pointing at a file on disk; the bytes live under
-- MEDIA_ROOT (see backend/lib/media.js). Storing video in a Postgres column
-- the way `documents.data_url` stores base64 would be gigabytes of text in
-- a row that every query has to step over.
--
-- `unique (student_id, period)` makes "one video per student per month" a
-- database rule rather than a convention the upload screen has to remember.
-- Re-uploading a month replaces the row (and deletes the old file), which is
-- what a teacher means when they upload a corrected video for October.
--
-- `visible_to_donor` defaults to FALSE on purpose. A sponsoring donor is a
-- third party and the family has not been told the sponsorship exists; video
-- of a named minor should reach a donor only when a person at the school
-- ticks the box for that specific video, never by default on every upload.

create table if not exists student_progress_videos (
  id                text primary key,
  student_id        text not null,
  period            text not null,              -- 'YYYY-MM'
  title             text,
  note              text,                       -- what the month showed
  storage_key       text not null,              -- path under MEDIA_ROOT
  mime_type         text,
  size_bytes        bigint,
  duration_sec      integer,
  original_name     text,
  uploaded_by       text,
  uploaded_by_id    text,
  uploaded_at       timestamptz default now(),
  visible_to_parent boolean default true,
  visible_to_donor  boolean default false,
  status            text default 'ready',       -- 'ready' | 'removed'
  removed_at        timestamptz,
  removed_by        text,
  unique (student_id, period)
);

create index if not exists idx_spv_student on student_progress_videos (student_id);
create index if not exists idx_spv_period  on student_progress_videos (period);
create index if not exists idx_spv_status  on student_progress_videos (status);

alter table student_progress_videos enable row level security;
