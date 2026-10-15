-- =============================================================================
-- Handmaidens of the Lord: database schema (run FIRST)
-- Order: 1) schema.sql  2) functions.sql  3) policies.sql
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

-- Private schema: helper functions and tables the website's API can never reach.
create schema if not exists private;

-- ---------------------------------------------------------------------------
-- admin_roles: who may administer the system.
-- Rows are inserted by a trusted person in the SQL editor (see README); there
-- is no insert/update/delete policy, so nobody can promote themselves.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'admin' check (role in ('admin')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- events
-- Times are interpreted in the Africa/Nairobi time zone (see private.event_tz).
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 3 and 150),
  description text not null default '' check (char_length(description) <= 5000),
  venue text not null check (char_length(btrim(venue)) between 2 and 200),
  event_date date not null,
  start_time time not null,
  end_time time,
  capacity integer not null check (capacity > 0 and capacity <= 100000),
  show_remaining boolean not null default true,
  poster_path text check (poster_path is null or char_length(poster_path) <= 300),
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_end_after_start check (end_time is null or end_time > start_time),
  constraint events_window_order check (
    registration_opens_at is null
    or registration_closes_at is null
    or registration_closes_at > registration_opens_at
  )
);

create index if not exists events_status_date_idx on public.events (status, event_date);

-- ---------------------------------------------------------------------------
-- registrations
-- Identity policy: one ACTIVE registration per event per e-mail address
-- (case-insensitive). A cancelled registration frees that e-mail to register again.
-- The QR token itself is never stored, only its SHA-256 hash.
-- ---------------------------------------------------------------------------
create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete restrict,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 100),
  email text not null check (
    char_length(email) <= 254 and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  phone text not null check (phone ~ '^\+[0-9]{9,15}$'),
  church_name text not null check (char_length(btrim(church_name)) between 2 and 150),
  registration_reference text not null unique,
  qr_token_hash text not null unique,
  status text not null default 'registered' check (status in ('registered', 'cancelled')),
  created_at timestamptz not null default now()
);

create unique index if not exists registrations_event_email_active_uq
  on public.registrations (event_id, lower(email))
  where status = 'registered';

create index if not exists registrations_event_idx on public.registrations (event_id, status);
create index if not exists registrations_phone_idx on public.registrations (event_id, phone);
create index if not exists registrations_name_idx on public.registrations (event_id, lower(full_name));

-- ---------------------------------------------------------------------------
-- attendance: at most one row per registration (enforced by the unique key).
-- ---------------------------------------------------------------------------
create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null unique references public.registrations (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete restrict,
  checked_in_at timestamptz not null default now(),
  method text not null check (method in ('qr', 'search', 'code', 'admin')),
  checked_in_by text not null check (char_length(checked_in_by) <= 200)
);

create index if not exists attendance_event_idx on public.attendance (event_id);

-- ---------------------------------------------------------------------------
-- volunteer_access: restricted, event-specific check-in links (no login).
-- Only the SHA-256 hash of each token is stored.
-- ---------------------------------------------------------------------------
create table if not exists public.volunteer_access (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  token_hash text not null unique,
  label text not null check (char_length(btrim(label)) between 1 and 60),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists volunteer_access_event_idx on public.volunteer_access (event_id);

-- ---------------------------------------------------------------------------
-- audit_log: who did what (written only by database functions).
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  event_id uuid,
  details jsonb not null default '{}'::jsonb
);

create index if not exists audit_log_event_idx on public.audit_log (event_id, at desc);

-- ---------------------------------------------------------------------------
-- private.rate_limits: lightweight abuse protection for the anonymous functions.
-- ---------------------------------------------------------------------------
create table if not exists private.rate_limits (
  key text not null,
  action text not null,
  at timestamptz not null default now()
);

create index if not exists rate_limits_lookup_idx on private.rate_limits (key, action, at desc);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
  before update on public.events
  for each row execute function private.touch_updated_at();

-- Capacity can never be lowered below the number of active registrations.
create or replace function private.guard_event_capacity()
returns trigger
language plpgsql
as $$
declare
  taken integer;
begin
  if new.capacity < old.capacity then
    select count(*) into taken
    from public.registrations
    where event_id = new.id and status = 'registered';

    if new.capacity < taken then
      raise exception 'Capacity (%) cannot be lower than the % active registrations.', new.capacity, taken
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists events_guard_capacity on public.events;
create trigger events_guard_capacity
  before update of capacity on public.events
  for each row execute function private.guard_event_capacity();
