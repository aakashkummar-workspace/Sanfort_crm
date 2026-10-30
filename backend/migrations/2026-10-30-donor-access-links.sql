-- One-click donor access links.
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code.
-- Safe to run twice. One new table; nothing existing changes.
--
-- Why: a donor should be able to tap a link rather than keep a password. The
-- trade is real — anyone holding the link is signed in — so the link expires
-- (30 days by default), can be revoked, and records every use. It is deliberately
-- scoped to the donor role only: no other role gets passwordless entry.
--
-- `token` is a 32-byte random value, stored hashed. A leak of this table alone
-- therefore does not hand anyone a working link.

create table if not exists donor_access_links (
  id          text primary key,
  donor_id    text not null,
  user_id     text not null,              -- the users row this link signs in as
  token_hash  text not null unique,       -- sha256 of the token; the raw value is shown once
  created_by  text,
  created_at  timestamptz default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  last_used_at timestamptz,
  use_count   int default 0
);

create index if not exists idx_dal_donor on donor_access_links (donor_id);
create index if not exists idx_dal_token on donor_access_links (token_hash);

alter table donor_access_links enable row level security;
