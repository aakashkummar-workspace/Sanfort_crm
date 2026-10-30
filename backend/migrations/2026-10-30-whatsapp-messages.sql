-- WhatsApp message log — the body of every message the CRM sends.
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code.
-- Safe to run twice; every statement is idempotent. Nothing existing changes —
-- this is a new table, and the code falls back to the JSON file store until it
-- exists (isSchemaMissError), so deploying code first only loses log rows.
--
-- Why: the only trace of a sent message was an audit_log row reading
-- "WhatsApp · fee_paid · sent · phone=91XXXXXXXXXX". The body was never stored
-- anywhere, so "what exactly did we send this parent?" was unanswerable, and a
-- failed send could not be re-sent because the text was gone. This table keeps
-- the message itself alongside the recipient, the student it concerned, who
-- triggered it, and the provider's own response.
--
-- media_url deliberately holds a URL only. fees/pay/route.js sends the receipt
-- as a base64 data URI (a full PNG, routinely 50-200KB); writing those into a
-- text column would grow the table by megabytes a day and make every list
-- query drag the images along. For a data URI the recorder sets has_media and
-- leaves media_url null — the receipt is reproducible from the fee row.

create table if not exists whatsapp_messages (
  id                  text primary key,
  provider            text,                      -- 'evolution' | 'meta'
  provider_message_id text,                      -- Evolution key.id — join target for a future delivery webhook
  event               text not null,             -- fee_paid | fee_qr_send | fee_reminder | broadcast | test
  direction           text default 'out',        -- 'out' today; 'in' when inbound replies land
  to_phone            text,
  recipient_name      text,
  student_id          text,
  student_name        text,
  body                text,                      -- the text sent, or the image caption
  media_url           text,                      -- URL only, NEVER a base64 data URI
  has_media           boolean default false,
  status              text default 'queued',     -- queued | sent | failed | skipped
  error               text,
  provider_response   jsonb,                     -- truncated to 2KB; a failing provider can return an HTML error page
  actor               text,
  actor_id            text,
  broadcast_id        text,
  retry_of            text,                      -- id of the row this is a manual re-send of
  attempt             int default 1,
  created_at          timestamptz default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz
);

-- The screen's default view is "newest first"; the rest are its filters. This
-- table grows with every fee payment, so each of these is a sequential scan
-- over the whole history without an index.
create index if not exists idx_wa_created   on whatsapp_messages (created_at desc);
create index if not exists idx_wa_student   on whatsapp_messages (student_id);
create index if not exists idx_wa_status    on whatsapp_messages (status);
create index if not exists idx_wa_phone     on whatsapp_messages (to_phone);

alter table whatsapp_messages enable row level security;
