-- Phase 7.2: immutable Legal Decision Object snapshots.

create schema if not exists app;

create table if not exists app.legal_decisions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references app.cases(case_id) on delete cascade,
  version_hash text not null,
  decision_status text not null,
  decision_data jsonb not null,
  source_pipeline_version text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  supersedes_decision_id uuid null references app.legal_decisions(id),
  is_latest boolean not null default true,
  constraint legal_decisions_case_version_unique unique (case_id, version_hash),
  constraint legal_decisions_status_check check (
    decision_status in ('READY', 'WARNING', 'HUMAN_REVIEW_REQUIRED', 'BLOCKED')
  )
);

create index if not exists legal_decisions_case_created_at_idx
  on app.legal_decisions (case_id, created_at desc);

create index if not exists legal_decisions_case_latest_idx
  on app.legal_decisions (case_id, is_latest);

create index if not exists legal_decisions_version_hash_idx
  on app.legal_decisions (version_hash);

create index if not exists legal_decisions_data_gin_idx
  on app.legal_decisions using gin (decision_data);

create or replace function app.prevent_legal_decision_data_update()
returns trigger
language plpgsql
as $$
begin
  if new.decision_data is distinct from old.decision_data then
    raise exception 'decision_data is immutable after insert';
  end if;
  return new;
end;
$$;

drop trigger if exists legal_decisions_immutable_data on app.legal_decisions;
create trigger legal_decisions_immutable_data
  before update on app.legal_decisions
  for each row
  execute function app.prevent_legal_decision_data_update();

alter table app.legal_decisions enable row level security;

create policy legal_decisions_case_access_select
  on app.legal_decisions
  for select
  to authenticated
  using (app.can_read_case(legal_decisions.case_id));

create policy legal_decisions_service_select
  on app.legal_decisions
  for select
  to service_role
  using (true);

create policy legal_decisions_service_insert
  on app.legal_decisions
  for insert
  to service_role
  with check (true);

create policy legal_decisions_service_update
  on app.legal_decisions
  for update
  to service_role
  using (true)
  with check (true);

grant usage on schema app to authenticated, service_role;
grant select on app.legal_decisions to authenticated;
grant select, insert on app.legal_decisions to service_role;
grant update (is_latest, supersedes_decision_id) on app.legal_decisions to service_role;

comment on table app.legal_decisions is
  'Immutable Legal Decision Object snapshots. decision_data is append-only; only is_latest/supersession metadata may change.';
