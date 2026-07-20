-- Daisly deploy-ready storage for the current web app.
-- Run this in Supabase SQL Editor before setting STORAGE_MODE=supabase.

create table if not exists public.daisly_app_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.daisly_app_state enable row level security;

-- The deployed Node backend uses the Supabase service role key.
-- Service role bypasses RLS, so no public anon policies are created here.
-- Keep this table private until auth/multi-user tables are added.

create or replace function public.touch_daisly_app_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists daisly_app_state_touch_updated_at on public.daisly_app_state;
create trigger daisly_app_state_touch_updated_at
before update on public.daisly_app_state
for each row
execute function public.touch_daisly_app_state_updated_at();
