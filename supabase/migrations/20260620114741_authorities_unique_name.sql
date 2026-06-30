-- AI LEGAL ARMENIA - idempotent authority upserts need a stable natural key.

create unique index if not exists authorities_name_normalized_unique_idx
  on public.authorities (name_normalized)
  where name_normalized is not null;
