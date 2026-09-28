-- SCALE indicators are scored on their own scale (1-10 for Lesson test,
-- Reading fluency, Handwriting, …), but scale_entries only accepted 1-4 and
-- the app clamped every score to 4. Widen the check so 1-10 marks persist.
-- Run this BEFORE deploying the matching db.js change.
do $$
declare c text;
begin
  for c in
    select con.conname from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'scale_entries' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%score%'
  loop
    execute format('alter table scale_entries drop constraint %I', c);
  end loop;
end $$;

alter table scale_entries
  add constraint scale_entries_score_check check (score between 1 and 10);
