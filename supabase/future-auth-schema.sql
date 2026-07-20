-- Future normalized schema for real multi-user Daisly accounts.
-- This is not wired into server.js yet; keep it as the next backend step.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text,
  avatar_initial text,
  onboarded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  language text not null default 'English',
  theme text not null default 'Sage',
  icloud boolean not null default false,
  google_calendar boolean not null default false,
  google_tasks boolean not null default false,
  notifications boolean not null default false,
  sound text not null default 'Chime',
  warn_before_minutes int not null default 15,
  task_start_alert boolean not null default true,
  task_end_alert boolean not null default true,
  morning_planning boolean not null default true,
  overdue_tasks boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  icon text not null default 'briefcase',
  color text not null default '#5E9478',
  type text not null default 'task',
  duration_minutes int not null default 30,
  day int,
  time_minutes int,
  done boolean not null default false,
  locked text,
  repeat jsonb,
  source text,
  meet boolean not null default false,
  notify_before_minutes int,
  description text not null default '',
  subtasks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  handle text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.group_tasks (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  assignee_id uuid references public.profiles(id) on delete set null,
  title text not null,
  icon text not null default 'briefcase',
  color text not null default '#5E9478',
  type text not null default 'task',
  duration_minutes int not null default 30,
  time_minutes int,
  status text not null default 'invited',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.tasks enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_tasks enable row level security;
