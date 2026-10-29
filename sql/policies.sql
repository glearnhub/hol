-- =============================================================================
-- Handmaidens of the Lord: grants, Row Level Security and Storage (run THIRD)
--
-- Model, in one paragraph:
--   * Anonymous visitors can read the public_events VIEW and call a short list
--     of functions. They have no access at all to the base tables.
--   * Signed-in administrators (rows in admin_roles) manage events directly
--     (RLS-checked) and everything else through admin_* functions.
--   * Volunteers never sign in; they call the volunteer_* functions with their
--     link's secret token, which only ever reaches one event.
-- RLS is enabled on every table and never disabled.
-- =============================================================================

-- 1. Start from nothing: remove the default open grants Supabase adds.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;

revoke all on schema private from anon, authenticated, public;
revoke all on all tables in schema private from anon, authenticated, public;
revoke all on all functions in schema private from anon, authenticated, public;

-- 2. Turn Row Level Security on everywhere.
alter table public.admin_roles enable row level security;
alter table public.events enable row level security;
alter table public.registrations enable row level security;
alter table public.attendance enable row level security;
alter table public.volunteer_access enable row level security;
alter table public.audit_log enable row level security;
alter table public.people enable row level security;
alter table public.attendance_corrections enable row level security;
alter table private.rate_limits enable row level security;

-- 3. Policies ----------------------------------------------------------------

-- admin_roles: a signed-in user may only see their OWN row (used to check
-- "am I an admin?"). No insert/update/delete policy exists, so roles can only
-- be granted by someone with SQL access (service role / SQL editor).
drop policy if exists "Read own admin role" on public.admin_roles;
create policy "Read own admin role"
  on public.admin_roles for select
  to authenticated
  using (user_id = auth.uid());

-- events: administrators only. The public sees events through public_events.
drop policy if exists "Admins read events" on public.events;
create policy "Admins read events"
  on public.events for select
  to authenticated
  using (public.is_staff());

drop policy if exists "Admins create events" on public.events;
create policy "Admins create events"
  on public.events for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "Admins update events" on public.events;
create policy "Admins update events"
  on public.events for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- registrations: full records are visible to administrators only. Creating,
-- cancelling and editing happen exclusively inside the functions.
drop policy if exists "Admins read registrations" on public.registrations;
create policy "Admins read registrations"
  on public.registrations for select
  to authenticated
  using (public.is_staff());

-- attendance: administrators may read; writes happen only in functions.
drop policy if exists "Admins read attendance" on public.attendance;
create policy "Admins read attendance"
  on public.attendance for select
  to authenticated
  using (public.is_staff());

-- volunteer_access: administrators may read link metadata (never the hash,
-- see the column grants below).
drop policy if exists "Admins read volunteer links" on public.volunteer_access;
create policy "Admins read volunteer links"
  on public.volunteer_access for select
  to authenticated
  using (public.is_admin());

-- people and attendance_corrections: administrators read; every change goes through
-- the admin_* functions (the directory is never opened to the public API).
drop policy if exists "Admins read people" on public.people;
create policy "Admins read people"
  on public.people for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins read attendance corrections" on public.attendance_corrections;
create policy "Admins read attendance corrections"
  on public.attendance_corrections for select
  to authenticated
  using (public.is_admin());

-- audit_log: administrators read-only.
drop policy if exists "Admins read audit log" on public.audit_log;
create policy "Admins read audit log"
  on public.audit_log for select
  to authenticated
  using (public.is_admin());

-- 4. Table privileges (RLS still applies on top of these) --------------------
grant select on public.admin_roles to authenticated;

grant select on public.events to authenticated;
grant insert (name, description, venue, event_date, start_time, end_date, end_time, capacity,
              category, visibility, attendance_enabled, registration_enabled,
              show_remaining, poster_path, registration_opens_at,
              registration_closes_at, status)
  on public.events to authenticated;
grant update (name, description, venue, event_date, start_time, end_date, end_time, capacity,
              category, visibility, attendance_enabled, registration_enabled,
              show_remaining, poster_path, registration_opens_at,
              registration_closes_at, status)
  on public.events to authenticated;

grant select on public.registrations to authenticated;
grant select on public.attendance to authenticated;
grant select (id, event_id, label, expires_at, revoked_at, last_used_at, created_by, created_at)
  on public.volunteer_access to authenticated;
grant select on public.audit_log to authenticated;

-- The public event listing: readable by everyone, including anonymous visitors.
grant select on public.public_events to anon, authenticated;

-- 5. Function privileges -------------------------------------------------------
-- Needed by RLS policy expressions and the admin UI.
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.my_role() to authenticated;

-- Anonymous workflows: registration, re-opening a confirmation, volunteer check-in.
grant execute on function public.register_participant(uuid, text, text, text, text, boolean) to anon, authenticated;
grant execute on function public.get_registration_confirmation(text, text) to anon, authenticated;
grant execute on function public.volunteer_event(text) to anon, authenticated;
grant execute on function public.volunteer_search(text, text) to anon, authenticated;
grant execute on function public.volunteer_check_in(text, uuid) to anon, authenticated;
grant execute on function public.volunteer_check_in_qr(text, text) to anon, authenticated;
grant execute on function public.volunteer_search_people(text, text) to anon, authenticated;
grant execute on function public.volunteer_check_in_person(text, uuid) to anon, authenticated;
grant execute on function public.volunteer_register_walkin(text, text, text, text, text, boolean) to anon, authenticated;
grant execute on function public.registration_link_event(text) to anon, authenticated;
grant execute on function public.register_via_link(text, text, text, text, text, boolean) to anon, authenticated;

-- Administrator functions (each also verifies admin_roles itself).
grant execute on function public.admin_create_volunteer_link(uuid, text, timestamptz, boolean) to authenticated;
grant execute on function public.admin_revoke_volunteer_link(uuid) to authenticated;
grant execute on function public.admin_regenerate_volunteer_link(uuid, timestamptz) to authenticated;
grant execute on function public.admin_set_attendance(uuid, boolean, text) to authenticated;
grant execute on function public.admin_cancel_registration(uuid) to authenticated;
grant execute on function public.admin_list_registrations(uuid, text, text, text, integer, integer) to authenticated;
grant execute on function public.admin_event_report(uuid) to authenticated;
grant execute on function public.admin_reports_overview() to authenticated;
grant execute on function public.admin_dashboard_stats() to authenticated;
grant execute on function public.admin_event_links(uuid) to authenticated;
grant execute on function public.staff_search_people(uuid, text) to authenticated;
grant execute on function public.admin_registration_link(uuid, text, timestamptz) to authenticated;
grant execute on function public.admin_set_person_attendance(uuid, uuid, boolean, text) to authenticated;
grant execute on function public.admin_find_duplicates(text, text, text, text, uuid) to authenticated;
grant execute on function public.admin_create_member(text, text, text, text, text, date, text, text, text, boolean) to authenticated;
grant execute on function public.admin_update_person(uuid, text, text, text, text, text, date, text, text, text, boolean) to authenticated;
grant execute on function public.admin_set_person_status(uuid, text) to authenticated;
grant execute on function public.admin_convert_visitor(uuid, text, text, text, text, text, date, text, text, text) to authenticated;
grant execute on function public.admin_list_people(text, text, text, text, date, date, text, integer, integer, boolean, integer) to authenticated;
grant execute on function public.admin_get_person(uuid, integer) to authenticated;
grant execute on function public.admin_event_attendance_report(uuid) to authenticated;
grant execute on function public.admin_annual_attendance(integer, text, boolean, text) to authenticated;
grant execute on function public.admin_lapsed_members(integer) to authenticated;

-- 6. Storage: event posters -------------------------------------------------------
-- The bucket is PRIVATE and capped at 2 MB per image. Anonymous visitors are
-- allowed to read a poster only when it belongs to a published event (the site
-- then asks for a short-lived signed link). Only administrators can upload,
-- replace or delete.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-posters', 'event-posters', false, 2097152,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "Posters of published events are readable" on storage.objects;
create policy "Posters of published events are readable"
  on storage.objects for select
  to anon, authenticated
  using (
    bucket_id = 'event-posters'
    and exists (
      select 1 from public.public_events pe where pe.poster_path = storage.objects.name
    )
  );

drop policy if exists "Admins read all posters" on storage.objects;
create policy "Admins read all posters"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'event-posters' and public.is_admin());

drop policy if exists "Admins upload posters" on storage.objects;
create policy "Admins upload posters"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'event-posters' and public.is_admin());

drop policy if exists "Admins replace posters" on storage.objects;
create policy "Admins replace posters"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'event-posters' and public.is_admin())
  with check (bucket_id = 'event-posters' and public.is_admin());

drop policy if exists "Admins delete posters" on storage.objects;
create policy "Admins delete posters"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'event-posters' and public.is_admin());
