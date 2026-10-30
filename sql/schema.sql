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
  end_date date,            -- null = the event ends on event_date (set it for overnight events)
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
  constraint events_end_date_valid check (end_date is null or end_date >= event_date),
  constraint events_window_order check (
    registration_opens_at is null
    or registration_closes_at is null
    or registration_closes_at > registration_opens_at
  )
);

create index if not exists events_status_date_idx on public.events (status, event_date);

-- Upgrade for databases created before end_date existed: an event may now end on a
-- later day (a night vigil that finishes at 5 am). The end moment must be after the start.
alter table public.events add column if not exists end_date date;
alter table public.events drop constraint if exists events_end_after_start;
alter table public.events drop constraint if exists events_end_date_valid;
alter table public.events drop constraint if exists events_end_after_start_at;
alter table public.events add constraint events_end_date_valid
  check (end_date is null or end_date >= event_date);
alter table public.events add constraint events_end_after_start_at
  check (
    (coalesce(end_date, event_date) + coalesce(end_time, time '23:59:59'))
      > (event_date + start_time)
  );

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
  email text check (   -- optional: null when the participant gives no email address
    char_length(email) <= 254 and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  phone text not null check (phone ~ '^\+[0-9]{9,15}$'),
  church_name text not null check (char_length(btrim(church_name)) between 2 and 150),
  registration_reference text not null unique,
  qr_token_hash text not null unique,
  status text not null default 'registered' check (status in ('registered', 'cancelled')),
  consented_at timestamptz,   -- when the participant ticked the data-use consent box
  created_at timestamptz not null default now()
);

-- Upgrade for databases created before consent was recorded.
alter table public.registrations add column if not exists consented_at timestamptz;
-- Upgrade: the email address became optional (phone number is the required contact).
alter table public.registrations alter column email drop not null;

create unique index if not exists registrations_event_email_active_uq
  on public.registrations (event_id, lower(email))
  where status = 'registered';

-- The same phone number may not hold two active registrations for one event. Created
-- only when the data is already clean; the registration function enforces the rule
-- either way, so a database with old duplicates is not blocked from upgrading.
do $$
begin
  if not exists (
    select 1 from public.registrations where status = 'registered'
    group by event_id, phone having count(*) > 1
  ) then
    create unique index if not exists registrations_event_phone_active_uq
      on public.registrations (event_id, phone)
      where status = 'registered';
  else
    raise notice 'Duplicate phone numbers already exist; the phone unique index was not created. Cancel the duplicates, then re-run schema.sql.';
  end if;
end $$;

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

-- =============================================================================
-- Members, visitors and attendance (enhancement)
-- Everything below is idempotent and upgrades an existing database in place.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Roles: administrators do everything; managers handle attendance and reports.
-- ---------------------------------------------------------------------------
alter table public.admin_roles drop constraint if exists admin_roles_role_check;
alter table public.admin_roles
  add constraint admin_roles_role_check check (role in ('admin', 'manager'));

-- ---------------------------------------------------------------------------
-- events: category, visibility, per-event switches, and a "completed" status.
--   visibility: public   = listed on the website and open to the public
--               private  = never listed; reached only through its secret links
--               internal = like private, for meetings among leaders/members
-- ---------------------------------------------------------------------------
alter table public.events add column if not exists category text not null default 'general';
alter table public.events add column if not exists visibility text not null default 'public';
alter table public.events add column if not exists attendance_enabled boolean not null default true;
alter table public.events add column if not exists registration_enabled boolean not null default true;

alter table public.events drop constraint if exists events_category_check;
alter table public.events add constraint events_category_check check (
  category in ('general', 'service', 'prayer', 'fellowship', 'training', 'leadership', 'conference', 'outreach', 'other')
);
alter table public.events drop constraint if exists events_visibility_check;
alter table public.events add constraint events_visibility_check check (
  visibility in ('public', 'private', 'internal')
);
alter table public.events drop constraint if exists events_status_check;
alter table public.events add constraint events_status_check check (
  status in ('draft', 'published', 'completed', 'cancelled')
);

-- ---------------------------------------------------------------------------
-- people: ONE identity per person, member or visitor. Converting a visitor into a
-- member changes `kind` on the same row, so registrations and attendance stay
-- attached. What the person was at each event is kept on those records
-- (registrations.classification, attendance.classification).
-- ---------------------------------------------------------------------------
create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  person_no bigint generated always as identity,
  kind text not null default 'visitor' check (kind in ('member', 'visitor')),
  full_name text not null check (char_length(btrim(full_name)) between 2 and 100),
  phone text not null check (phone ~ '^\+[0-9]{9,15}$'),
  alt_phone text check (alt_phone is null or alt_phone ~ '^\+[0-9]{9,15}$'),
  email text check (
    email is null
    or (char_length(email) <= 254 and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  ),
  gender text check (gender is null or gender in ('female', 'male', 'other')),
  church_name text check (church_name is null or char_length(church_name) <= 150),
  department text check (department is null or char_length(department) <= 100),
  residence text check (residence is null or char_length(residence) <= 150),
  deaconess text check (deaconess is null or char_length(deaconess) <= 100),
  membership_type text not null default 'visitor'
    check (membership_type in ('incoming_commitment', 'in_commitment', 'member', 'visitor')),
  membership_date date,
  status text not null default 'active' check (status in ('active', 'inactive')),
  needs_review boolean not null default false,
  review_note text check (review_note is null or char_length(review_note) <= 500),
  notes text check (notes is null or char_length(notes) <= 1000),
  became_member_at timestamptz,
  created_by text not null default 'system' check (char_length(created_by) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A phone number identifies one person. (Two people sharing a phone are told apart
-- by giving one of them their own number, or the alternative number field.)
create unique index if not exists people_phone_uq on public.people (phone);
create unique index if not exists people_person_no_uq on public.people (person_no);
create index if not exists people_name_idx on public.people (lower(full_name));
create index if not exists people_kind_status_idx on public.people (kind, status);
create index if not exists people_alt_phone_idx on public.people (alt_phone) where alt_phone is not null;

drop trigger if exists people_touch_updated_at on public.people;
create trigger people_touch_updated_at
  before update on public.people
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Member details: residence, department (where they serve in church), deaconess (the
-- leader assigned to mentor them) and the membership type. "ministry" was the first name
-- of the department field, so it is renamed, keeping what was typed into it.
--   membership_type: incoming_commitment | in_commitment | member | visitor
--   kind (member / visitor) follows it: only the type "visitor" is a visitor.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'people' and column_name = 'ministry')
     and not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'people' and column_name = 'department') then
    alter table public.people rename column ministry to department;
  end if;
end $$;

alter table public.people add column if not exists department text;
alter table public.people add column if not exists residence text;
alter table public.people add column if not exists deaconess text;
alter table public.people add column if not exists membership_type text not null default 'visitor';

alter table public.people drop constraint if exists people_department_check;
alter table public.people add constraint people_department_check check (department is null or char_length(department) <= 100);
alter table public.people drop constraint if exists people_residence_check;
alter table public.people add constraint people_residence_check check (residence is null or char_length(residence) <= 150);
alter table public.people drop constraint if exists people_deaconess_check;
alter table public.people add constraint people_deaconess_check check (deaconess is null or char_length(deaconess) <= 100);
alter table public.people drop constraint if exists people_membership_type_check;
alter table public.people add constraint people_membership_type_check
  check (membership_type in ('incoming_commitment', 'in_commitment', 'member', 'visitor'));

-- People who were members before this existed are plain "member".
update public.people set membership_type = 'member' where kind = 'member' and membership_type = 'visitor';

alter table public.people drop constraint if exists people_type_matches_kind;
alter table public.people add constraint people_type_matches_kind
  check ((kind = 'visitor') = (membership_type = 'visitor'));

create index if not exists people_department_idx on public.people (lower(department)) where department is not null;
create index if not exists people_deaconess_idx on public.people (lower(deaconess)) where deaconess is not null;

-- ---------------------------------------------------------------------------
-- registrations and attendance point at a person.
-- ---------------------------------------------------------------------------
alter table public.registrations add column if not exists person_id uuid references public.people (id) on delete restrict;
alter table public.registrations add column if not exists classification text;
alter table public.registrations drop constraint if exists registrations_classification_check;
alter table public.registrations add constraint registrations_classification_check
  check (classification is null or classification in ('member', 'visitor'));

alter table public.attendance add column if not exists person_id uuid references public.people (id) on delete restrict;
alter table public.attendance add column if not exists classification text;
alter table public.attendance drop constraint if exists attendance_classification_check;
alter table public.attendance add constraint attendance_classification_check
  check (classification is null or classification in ('member', 'visitor'));
-- A member can be marked present without having registered first.
alter table public.attendance alter column registration_id drop not null;
alter table public.attendance drop constraint if exists attendance_method_check;
alter table public.attendance add constraint attendance_method_check
  check (method in ('qr', 'search', 'code', 'admin', 'walkin'));

-- ---------------------------------------------------------------------------
-- attendance_corrections: what was removed or added by hand, by whom and why.
-- Removing someone's attendance keeps a full copy here.
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_corrections (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null check (action in ('removed', 'added')),
  event_id uuid not null,
  person_id uuid,
  registration_id uuid,
  classification text,
  method text,
  original_checked_in_at timestamptz,
  original_checked_in_by text,
  reason text check (reason is null or char_length(reason) <= 300)
);

create index if not exists attendance_corrections_event_idx on public.attendance_corrections (event_id, at desc);

-- ---------------------------------------------------------------------------
-- One-off link-up of existing data: every distinct phone number among the old
-- registrations becomes one visitor, and their registrations and attendance are
-- attached to it. Nothing is deleted or changed otherwise.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.registrations where person_id is null) then
    insert into public.people (kind, full_name, phone, email, church_name, status, created_by, created_at)
    select distinct on (r.phone)
           'visitor', r.full_name, r.phone, r.email, r.church_name, 'active', 'migration', r.created_at
    from public.registrations r
    where r.person_id is null
    order by r.phone, r.created_at desc
    on conflict (phone) do nothing;

    update public.registrations r
    set person_id = p.id,
        classification = coalesce(r.classification, case when p.kind = 'member' then 'member' else 'visitor' end)
    from public.people p
    where p.phone = r.phone and r.person_id is null;
  end if;

  update public.attendance a
  set person_id = r.person_id,
      classification = coalesce(a.classification, r.classification, 'visitor')
  from public.registrations r
  where a.registration_id = r.id and a.person_id is null;
end $$;

-- From here on every registration and every attendance record belongs to a person.
-- (A trigger fills the link in for any insert that does not provide it.)
do $$
begin
  if not exists (select 1 from public.registrations where person_id is null) then
    alter table public.registrations alter column person_id set not null;
  end if;
  if not exists (select 1 from public.attendance where person_id is null) then
    alter table public.attendance alter column person_id set not null;
  end if;
end $$;

create index if not exists registrations_person_idx on public.registrations (person_id);
create index if not exists attendance_person_idx on public.attendance (person_id);

-- Older data can hold two attendance rows for the same person at the same event (for
-- example one phone number registered twice and both registrations checked in). A person
-- counts once per event, so the EARLIEST check-in is kept and each extra row is copied to
-- attendance_corrections (nothing is lost) before it is removed.
do $$
begin
  with ranked as (
    select a.*, row_number() over (partition by a.event_id, a.person_id order by a.checked_in_at, a.id) as rn
    from public.attendance a
    where a.person_id is not null
  ), extra as (
    select * from ranked where rn > 1
  ), logged as (
    insert into public.attendance_corrections
      (actor, action, event_id, person_id, registration_id, classification, method,
       original_checked_in_at, original_checked_in_by, reason)
    select 'system:upgrade', 'removed', e.event_id, e.person_id, e.registration_id, e.classification, e.method,
           e.checked_in_at, e.checked_in_by,
           'Duplicate attendance for the same person at the same event, merged during the upgrade'
    from extra e
    returning 1
  )
  delete from public.attendance a using extra x where a.id = x.id;
end $$;

-- One attendance record per person per event, however it was recorded.
create unique index if not exists attendance_event_person_uq on public.attendance (event_id, person_id);

-- ---------------------------------------------------------------------------
-- Event links: the same table serves the usher attendance links and each event's
-- registration link. The registration link and new attendance links keep their
-- token (token_plain) so the administrator can copy them again later; the table
-- is not readable by the website's API roles, only through admin functions.
-- ---------------------------------------------------------------------------
alter table public.volunteer_access add column if not exists kind text not null default 'attendance';
alter table public.volunteer_access drop constraint if exists volunteer_access_kind_check;
alter table public.volunteer_access add constraint volunteer_access_kind_check
  check (kind in ('attendance', 'registration'));
alter table public.volunteer_access add column if not exists token_plain text;
alter table public.volunteer_access add column if not exists allow_walkins boolean not null default true;
alter table public.volunteer_access add column if not exists auto_managed boolean not null default false;
alter table public.volunteer_access alter column expires_at drop not null;

-- At most one live registration link per event.
create unique index if not exists volunteer_access_one_registration_link_uq
  on public.volunteer_access (event_id)
  where kind = 'registration' and revoked_at is null;
