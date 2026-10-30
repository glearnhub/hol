-- =============================================================================
-- Handmaidens of the Lord: database functions (run SECOND, after schema.sql)
--
-- Everything the website needs beyond plain reads goes through these functions.
-- The public ones are SECURITY DEFINER so they can touch tables that anonymous
-- visitors have NO direct access to, and each one validates its own inputs,
-- scopes access to a single event, and rate-limits abuse.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Private helpers (not reachable through the API)
-- ---------------------------------------------------------------------------

-- Event times are entered and interpreted in Nairobi time.
-- Guard: run schema.sql (successfully) before this file.
do $$
begin
  if to_regclass('public.people') is null
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'attendance' and column_name = 'person_id') then
    raise exception 'Run sql/schema.sql first and make sure it finishes without an error, then run this file again.';
  end if;
end $$;

create or replace function private.event_tz()
returns text
language sql
immutable
as $$ select 'Africa/Nairobi'::text $$;

create or replace function private.event_start_at(e public.events)
returns timestamptz
language sql
stable
as $$ select (e.event_date + e.start_time) at time zone private.event_tz() $$;

create or replace function private.event_end_at(e public.events)
returns timestamptz
language sql
stable
as $$ select (coalesce(e.end_date, e.event_date) + coalesce(e.end_time, time '23:59:59')) at time zone private.event_tz() $$;

-- New random secret: two UUIDv4 values, about 244 bits of randomness.
create or replace function private.new_token()
returns text
language sql
volatile
as $$ select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;

create or replace function private.hash_token(p_token text)
returns text
language sql
immutable
as $$ select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') $$;

-- Normalises a phone number to +<digits>. Local Kenyan numbers (07.., 01.., 7..)
-- become +254...; numbers already carrying a country code are kept.
create or replace function private.normalize_phone(p text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
begin
  -- Every way of writing the same Kenyan number ends up as +254XXXXXXXXX, so
  -- 0702499324, 702499324, 254702499324, +254702499324 and +254 0702 499 324
  -- are all treated as one phone number.
  d := regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g');
  if d like '+%' then
    d := regexp_replace(substr(d, 2), '[^0-9]', '', 'g');
  elsif d like '00%' then
    d := substr(d, 3);
  elsif d like '0%' then
    d := '254' || substr(d, 2);
  elsif d ~ '^[17][0-9]{8}$' then
    d := '254' || d;
  end if;
  -- "+254 0712..." (the leading 0 typed again after the country code)
  if d ~ '^2540[0-9]{9}$' then
    d := '254' || substr(d, 5);
  end if;
  return '+' || d;
end;
$$;

create or replace function private.escape_like(p text)
returns text
language sql
immutable
as $$ select replace(replace(replace(coalesce(p, ''), '\', '\\'), '%', '\%'), '_', '\_') $$;

-- Best-effort client address, used only to throttle anonymous abuse.
create or replace function private.client_ip()
returns text
language plpgsql
stable
as $$
declare
  h json;
  v text;
begin
  begin
    h := current_setting('request.headers', true)::json;
  exception when others then
    h := null;
  end;
  v := coalesce(nullif(btrim(h ->> 'cf-connecting-ip'), ''),
                nullif(btrim(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1)), ''),
                'unknown');
  return left(v, 64);
end;
$$;

-- Records one hit and returns false when the allowance is used up.
create or replace function private.rate_limit(p_key text, p_action text, p_max integer, p_window interval)
returns boolean
language plpgsql
volatile
as $$
declare
  n integer;
begin
  if random() < 0.02 then
    delete from private.rate_limits where at < now() - interval '1 day';
  end if;

  select count(*) into n
  from private.rate_limits
  where key = p_key and action = p_action and at > now() - p_window;

  if n >= p_max then
    return false;
  end if;

  insert into private.rate_limits (key, action) values (p_key, p_action);
  return true;
end;
$$;

create or replace function private.failure_count(p_key text, p_action text, p_window interval)
returns integer
language sql
stable
as $$
  select count(*)::integer from private.rate_limits
  where key = p_key and action = p_action and at > now() - p_window
$$;

create or replace function private.audit(p_actor text, p_action text, p_event_id uuid, p_details jsonb default '{}'::jsonb)
returns void
language sql
volatile
as $$
  insert into public.audit_log (actor, action, event_id, details)
  values (p_actor, p_action, p_event_id, coalesce(p_details, '{}'::jsonb))
$$;

create or replace function private.fail(p_error text, p_message text default null)
returns jsonb
language sql
immutable
as $$ select jsonb_build_object('ok', false, 'error', p_error, 'message', p_message) $$;

-- ---------------------------------------------------------------------------
-- is_admin(): used by Row Level Security policies and the admin functions.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.admin_roles where user_id = auth.uid() and role = 'admin')
$$;

create or replace function private.require_admin()
returns void
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not exists (select 1 from public.admin_roles where user_id = auth.uid() and role = 'admin') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public event listing (anonymous can read this view, never the base tables).
-- Only published events appear; counts are computed here so participants never
-- need access to the registrations table.
-- ---------------------------------------------------------------------------
create or replace view public.public_events as
select
  e.id,
  e.name,
  e.description,
  e.venue,
  e.event_date,
  e.start_time,
  e.end_time,
  e.capacity,
  e.poster_path,
  e.registration_opens_at,
  e.registration_closes_at,
  e.show_remaining,
  case when e.show_remaining then greatest(e.capacity - c.taken, 0) end as spots_remaining,
  case
    -- Inline on purpose: functions inside a view run with the CALLER's privileges,
    -- and anonymous visitors must not be given access to the private schema.
    when e.status = 'completed'
      or now() > (coalesce(e.end_date, e.event_date) + coalesce(e.end_time, time '23:59:59')) at time zone 'Africa/Nairobi' then 'ended'
    when not e.registration_enabled then 'unavailable'
    when e.registration_opens_at is not null and now() < e.registration_opens_at then 'not_open'
    when e.registration_closes_at is not null and now() > e.registration_closes_at then 'closed'
    when c.taken >= e.capacity then 'full'
    else 'open'
  end as registration_state,
  -- Appended last: CREATE OR REPLACE VIEW can only add columns at the end.
  e.end_date
from public.events e
cross join lateral (
  select count(*)::integer as taken
  from public.registrations r
  where r.event_id = e.id and r.status = 'registered'
) c
-- Only public events are listed; private and internal events are reached by their links.
where e.status in ('published', 'completed') and e.visibility = 'public';

-- ---------------------------------------------------------------------------
-- register_participant(): the ONLY way a participant is created.
-- The event row is locked FOR UPDATE, so concurrent registrations for one event
-- are processed one at a time and capacity can never be exceeded.
-- ---------------------------------------------------------------------------
-- The signature gained p_consent, so the old five-argument version must go.
drop function if exists public.register_participant(uuid, text, text, text, text);

create or replace function private.do_register(
  p_event_id uuid,
  p_full_name text,
  p_email text,
  p_phone text,
  p_church_name text,
  p_consent boolean default false,
  p_via_link boolean default false
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  ev public.events;
  v_name text;
  v_email text;
  v_phone text;
  v_church text;
  taken integer;
  v_ref text;
  v_token text;
  v_id uuid;
  v_person public.people;
  v_class text;
  attempts integer := 0;
begin
  if not private.rate_limit('reg:' || private.client_ip(), 'register', 15, interval '1 hour') then
    return private.fail('rate_limited', 'Too many registration attempts. Please try again later.');
  end if;

  v_name := btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
  -- The email address is optional: blank means "none given" and is stored as null.
  v_email := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_phone := private.normalize_phone(p_phone);
  v_church := btrim(regexp_replace(coalesce(p_church_name, ''), '\s+', ' ', 'g'));

  if char_length(v_name) < 2 or char_length(v_name) > 100 then
    return private.fail('invalid_name', 'Please enter your full name.');
  end if;
  if v_email is not null
     and (char_length(v_email) > 254 or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return private.fail('invalid_email', 'Please enter a valid email address.');
  end if;
  if v_phone !~ '^\+[0-9]{9,15}$' then
    return private.fail('invalid_phone', 'Please enter a valid phone number.');
  end if;
  if char_length(v_church) < 2 or char_length(v_church) > 150 then
    return private.fail('invalid_church', 'Please enter your church name.');
  end if;
  -- Registration needs the participant's consent to the use of their details.
  if p_consent is not true then
    return private.fail('consent_required', 'Please tick the consent box to register.');
  end if;

  select * into ev from public.events where id = p_event_id for update;

  if not found or ev.status <> 'published' then
    return private.fail('event_unavailable', 'This event is not available for registration.');
  end if;
  -- Private and internal events can only be registered for through their secret link.
  if not p_via_link and ev.visibility <> 'public' then
    return private.fail('event_unavailable', 'This event is not available for registration.');
  end if;
  if now() > private.event_end_at(ev) then
    return private.fail('event_ended', 'This event has already taken place.');
  end if;
  if not ev.registration_enabled then
    return private.fail('registration_disabled', 'Registration is not available for this event.');
  end if;
  if ev.registration_opens_at is not null and now() < ev.registration_opens_at then
    return private.fail('registration_not_open', 'Registration for this event has not opened yet.');
  end if;
  if ev.registration_closes_at is not null and now() > ev.registration_closes_at then
    return private.fail('registration_closed', 'Registration for this event has closed.');
  end if;

  -- One active registration per person per event: the same e-mail address OR the same
  -- phone number (in any spelling, see normalize_phone) cannot register again. The event
  -- row is locked above, so two simultaneous attempts cannot both get through.
  if v_email is not null and exists (
    select 1 from public.registrations
    where event_id = ev.id and status = 'registered' and lower(email) = v_email
  ) then
    return private.fail('already_registered', 'This email address is already registered for this event.');
  end if;
  if exists (
    select 1 from public.registrations
    where event_id = ev.id and status = 'registered' and phone = v_phone
  ) then
    return private.fail('phone_already_registered', 'This phone number is already registered for this event.');
  end if;

  select count(*) into taken
  from public.registrations
  where event_id = ev.id and status = 'registered';

  if taken >= ev.capacity then
    return private.fail('event_full', 'Sorry, this event is fully booked.');
  end if;

  -- The person behind the registration: recognised by phone number, never duplicated.
  v_person := private.find_or_create_visitor(v_name, v_phone, v_email, v_church, 'registration');
  v_class := case when v_person.kind = 'member' then 'member' else 'visitor' end;

  loop
    attempts := attempts + 1;
    v_ref := 'HOL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    v_token := private.new_token();

    begin
      insert into public.registrations
        (event_id, full_name, email, phone, church_name, registration_reference, qr_token_hash, consented_at,
         person_id, classification)
      values
        (ev.id, v_name, v_email, v_phone, v_church, v_ref, private.hash_token(v_token), now(),
         v_person.id, v_class)
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_email is not null and exists (
        select 1 from public.registrations
        where event_id = ev.id and lower(email) = v_email and status = 'registered'
      ) then
        return private.fail('already_registered', 'This email address is already registered for this event.');
      end if;
      if exists (
        select 1 from public.registrations
        where event_id = ev.id and phone = v_phone and status = 'registered'
      ) then
        return private.fail('phone_already_registered', 'This phone number is already registered for this event.');
      end if;
      if attempts >= 5 then
        return private.fail('try_again', 'Something went wrong. Please try again.');
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'registration_reference', v_ref,
    'qr_token', v_token,
    'full_name', v_name,
    'event', jsonb_build_object(
      'id', ev.id, 'name', ev.name, 'venue', ev.venue, 'event_date', ev.event_date,
      'start_time', ev.start_time, 'end_date', ev.end_date, 'end_time', ev.end_time
    )
  );
end;
$$;

create or replace function public.register_participant(
  p_event_id uuid,
  p_full_name text,
  p_email text,
  p_phone text,
  p_church_name text,
  p_consent boolean default false
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  return private.do_register(p_event_id, p_full_name, p_email, p_phone, p_church_name, p_consent, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- get_registration_confirmation(): lets a participant re-open their
-- confirmation. Needs BOTH the reference and the secret token from their link.
-- ---------------------------------------------------------------------------
create or replace function public.get_registration_confirmation(p_reference text, p_token text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  r public.registrations;
  ev public.events;
begin
  if not private.rate_limit('conf:' || private.client_ip(), 'confirmation', 60, interval '1 hour') then
    return private.fail('rate_limited', 'Too many requests. Please try again later.');
  end if;

  select * into r
  from public.registrations
  where registration_reference = upper(btrim(coalesce(p_reference, '')))
    and qr_token_hash = private.hash_token(p_token);

  if not found then
    return private.fail('not_found', 'We could not find that registration.');
  end if;

  select * into ev from public.events where id = r.event_id;

  return jsonb_build_object(
    'ok', true,
    'registration_reference', r.registration_reference,
    'full_name', r.full_name,
    'registration_status', r.status,
    'checked_in', exists (select 1 from public.attendance a where a.registration_id = r.id),
    'event', jsonb_build_object(
      'id', ev.id, 'name', ev.name, 'venue', ev.venue, 'event_date', ev.event_date,
      'start_time', ev.start_time, 'end_date', ev.end_date, 'end_time', ev.end_time, 'status', ev.status
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Volunteer access (no login). Every function takes the event link's secret
-- token and is scoped to the single event that token belongs to.
-- ---------------------------------------------------------------------------
-- (the usher functions below also gained "attendance_disabled" and walk-in permission)
drop function if exists private.resolve_volunteer(text);

create or replace function private.resolve_volunteer(p_token text)
returns table (access_id uuid, event_id uuid, label text, state text, allow_walkins boolean)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  va public.volunteer_access;
  ev public.events;
  ip text := private.client_ip();
begin
  access_id := null; event_id := null; label := null; allow_walkins := false;

  -- Someone guessing tokens gets locked out for a while.
  if private.failure_count('vol-bad:' || ip, 'bad-token', interval '10 minutes') >= 20 then
    state := 'rate_limited';
    return next;
    return;
  end if;

  if p_token is null or char_length(p_token) < 20 or char_length(p_token) > 200 then
    insert into private.rate_limits (key, action) values ('vol-bad:' || ip, 'bad-token');
    state := 'invalid';
    return next;
    return;
  end if;

  select * into va from public.volunteer_access
  where token_hash = private.hash_token(p_token) and kind = 'attendance';

  if not found then
    insert into private.rate_limits (key, action) values ('vol-bad:' || ip, 'bad-token');
    state := 'invalid';
    return next;
    return;
  end if;

  if va.revoked_at is not null then
    state := 'revoked';
    return next;
    return;
  end if;
  if va.expires_at is not null and va.expires_at <= now() then
    state := 'expired';
    return next;
    return;
  end if;

  select * into ev from public.events where id = va.event_id;
  if not found or ev.status <> 'published' then
    state := 'event_unavailable';
    return next;
    return;
  end if;
  if not ev.attendance_enabled then
    state := 'attendance_disabled';
    return next;
    return;
  end if;

  if not private.rate_limit('vol:' || va.id::text, 'ops', 90, interval '1 minute') then
    state := 'rate_limited';
    return next;
    return;
  end if;

  update public.volunteer_access set last_used_at = now() where id = va.id;

  access_id := va.id;
  event_id := va.event_id;
  label := va.label;
  allow_walkins := va.allow_walkins;
  state := 'ok';
  return next;
end;
$$;

create or replace function private.volunteer_error(p_state text)
returns jsonb
language sql
immutable
as $$
  select case p_state
    when 'revoked' then private.fail('revoked', 'This check-in link has been revoked. Ask an administrator for a new one.')
    when 'expired' then private.fail('expired', 'This check-in link has expired. Ask an administrator for a new one.')
    when 'event_unavailable' then private.fail('event_unavailable', 'This event is not open for check-in.')
    when 'attendance_disabled' then private.fail('attendance_disabled', 'Attendance is not being recorded for this event.')
    when 'rate_limited' then private.fail('rate_limited', 'Too many requests. Please wait a moment and try again.')
    else private.fail('invalid_access', 'This check-in link is not valid.')
  end
$$;

-- Performs one check-in. Duplicate-safe: the unique key on attendance decides.
create or replace function private.do_check_in(
  p_access_id uuid,
  p_event_id uuid,
  p_registration_id uuid,
  p_method text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  r public.registrations;
  ev public.events;
  gate jsonb;
  v_kind text;
  v_at timestamptz;
  v_inserted uuid;
begin
  select * into r
  from public.registrations
  where id = p_registration_id and event_id = p_event_id and status = 'registered';

  if not found then
    return private.fail('not_found', 'No matching registration was found for this event.');
  end if;

  select * into ev from public.events where id = p_event_id;

  -- Check-in opens a week before the event and closes a day after it ends (Nairobi time).
  gate := private.check_in_gate(ev);
  if gate is not null then
    return gate;
  end if;

  select kind into v_kind from public.people where id = r.person_id;

  insert into public.attendance (registration_id, person_id, classification, event_id, method, checked_in_by)
  values (r.id, r.person_id, case when v_kind = 'member' then 'member' else 'visitor' end,
          r.event_id, p_method, p_actor)
  on conflict do nothing
  returning id into v_inserted;

  if v_inserted is not null then
    perform private.audit(p_actor, 'check_in', r.event_id,
      jsonb_build_object('registration_id', r.id, 'method', p_method));
    return jsonb_build_object('ok', true, 'result', 'checked_in', 'full_name', r.full_name,
                              'kind', coalesce(v_kind, 'visitor'), 'checked_in_at', now());
  end if;

  select checked_in_at into v_at from public.attendance
  where event_id = r.event_id and person_id = r.person_id;
  return jsonb_build_object('ok', true, 'result', 'already_checked_in', 'full_name', r.full_name,
                            'kind', coalesce(v_kind, 'visitor'), 'checked_in_at', v_at);
end;
$$;

create or replace function public.volunteer_event(p_token text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
  ev public.events;
begin
  select * into v from private.resolve_volunteer(p_token);
  if v.state <> 'ok' then
    return private.volunteer_error(v.state);
  end if;

  select * into ev from public.events where id = v.event_id;

  return jsonb_build_object(
    'ok', true,
    'label', v.label,
    'allow_walkins', v.allow_walkins,
    'event', jsonb_build_object(
      'name', ev.name, 'venue', ev.venue, 'event_date', ev.event_date,
      'start_time', ev.start_time, 'end_date', ev.end_date, 'end_time', ev.end_time
    ),
    'registered', (select count(*) from public.registrations
                   where event_id = ev.id and status = 'registered'),
    'checked_in', (select count(*) from public.attendance a where a.event_id = ev.id),
    'members_present', (select count(*) from public.attendance a
                        where a.event_id = ev.id and a.classification = 'member'),
    'visitors_present', (select count(*) from public.attendance a
                         where a.event_id = ev.id and a.classification = 'visitor')
  );
end;
$$;

-- Search by name or phone. Returns only what a volunteer needs to pick the
-- right person: name, a masked phone hint, and whether they are already in.
create or replace function public.volunteer_search(p_token text, p_query text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
  q text;
  digits text;
  results jsonb;
begin
  select * into v from private.resolve_volunteer(p_token);
  if v.state <> 'ok' then
    return private.volunteer_error(v.state);
  end if;

  q := btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g'));
  if char_length(q) < 3 then
    return private.fail('query_too_short', 'Type at least 3 characters.');
  end if;
  if char_length(q) > 60 then
    q := left(q, 60);
  end if;

  digits := regexp_replace(q, '[^0-9]', '', 'g');
  digits := regexp_replace(digits, '^0+', '');  -- 0712 345 678 -> 712345678

  select coalesce(jsonb_agg(row_to_json(m)::jsonb order by m.full_name), '[]'::jsonb) into results
  from (
    select
      r.id as registration_id,
      r.full_name,
      '••• ••• ' || right(r.phone, 3) as phone_hint,
      (a.id is not null) as checked_in,
      a.checked_in_at
    from public.registrations r
    left join public.attendance a on a.registration_id = r.id
    where r.event_id = v.event_id
      and r.status = 'registered'
      and (
        lower(r.full_name) like '%' || lower(private.escape_like(q)) || '%' escape '\'
        or (char_length(digits) >= 4 and r.phone like '%' || digits || '%')
      )
    order by r.full_name
    limit 10
  ) m;

  return jsonb_build_object('ok', true, 'results', results);
end;
$$;

create or replace function public.volunteer_check_in(p_token text, p_registration_id uuid)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  select * into v from private.resolve_volunteer(p_token);
  if v.state <> 'ok' then
    return private.volunteer_error(v.state);
  end if;

  return private.do_check_in(v.access_id, v.event_id, p_registration_id, 'search',
                             'volunteer:' || v.access_id::text);
end;
$$;

-- QR scan (or manual entry of the printed code). The code is either the secret
-- QR token or the registration reference; both are matched only within this event.
create or replace function public.volunteer_check_in_qr(p_token text, p_code text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
  code text;
  v_reg uuid;
  v_method text;
  v_event_name text;
begin
  select * into v from private.resolve_volunteer(p_token);
  if v.state <> 'ok' then
    return private.volunteer_error(v.state);
  end if;

  select name into v_event_name from public.events where id = v.event_id;

  code := btrim(coalesce(p_code, ''));
  if char_length(code) < 6 or char_length(code) > 200 then
    return private.fail('invalid_code', format('That code is not registered for "%s".', v_event_name));
  end if;

  if upper(code) like 'HOL-%' then
    select id into v_reg from public.registrations
    where event_id = v.event_id and registration_reference = upper(code) and status = 'registered';
    v_method := 'code';
  else
    select id into v_reg from public.registrations
    where event_id = v.event_id and qr_token_hash = private.hash_token(code) and status = 'registered';
    v_method := 'qr';
  end if;

  if v_reg is null then
    return private.fail(
      'invalid_code',
      format('That code is not registered for "%s". It may belong to a different event, or the registration was cancelled.', v_event_name)
    );
  end if;

  return private.do_check_in(v.access_id, v.event_id, v_reg, v_method, 'volunteer:' || v.access_id::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- Administrator functions (each refuses anyone who is not in admin_roles)
-- ---------------------------------------------------------------------------
drop function if exists public.admin_create_volunteer_link(uuid, text, timestamptz);

create or replace function public.admin_create_volunteer_link(
  p_event_id uuid,
  p_label text,
  p_expires_at timestamptz,
  p_allow_walkins boolean default true
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_token text;
  v_id uuid;
  v_label text := btrim(coalesce(p_label, ''));
begin
  perform private.require_admin();

  if not exists (select 1 from public.events where id = p_event_id) then
    return private.fail('not_found', 'Event not found.');
  end if;
  if char_length(v_label) not between 1 and 60 then
    return private.fail('invalid_label', 'Give the link a short label, for example "Main door".');
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '120 days' then
    return private.fail('invalid_expiry', 'Choose an expiry date within the next 120 days.');
  end if;

  v_token := private.new_token();
  insert into public.volunteer_access (event_id, kind, token_hash, token_plain, label, expires_at, allow_walkins)
  values (p_event_id, 'attendance', private.hash_token(v_token), v_token, v_label, p_expires_at,
          coalesce(p_allow_walkins, true))
  returning id into v_id;

  perform private.audit('admin:' || auth.uid()::text, 'volunteer_link_created', p_event_id,
    jsonb_build_object('access_id', v_id, 'label', v_label));

  return jsonb_build_object('ok', true, 'id', v_id, 'token', v_token, 'expires_at', p_expires_at);
end;
$$;

create or replace function public.admin_revoke_volunteer_link(p_access_id uuid)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
begin
  perform private.require_admin();

  update public.volunteer_access
  set revoked_at = coalesce(revoked_at, now())
  where id = p_access_id
  returning event_id into v_event;

  if v_event is null then
    return private.fail('not_found', 'Link not found.');
  end if;

  perform private.audit('admin:' || auth.uid()::text, 'volunteer_link_revoked', v_event,
    jsonb_build_object('access_id', p_access_id));
  return jsonb_build_object('ok', true);
end;
$$;

-- Revokes a link and issues a fresh one with the same label in one step.
create or replace function public.admin_regenerate_volunteer_link(p_access_id uuid, p_expires_at timestamptz)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  old public.volunteer_access;
  result jsonb;
begin
  perform private.require_admin();

  select * into old from public.volunteer_access where id = p_access_id;
  if not found then
    return private.fail('not_found', 'Link not found.');
  end if;

  if old.kind <> 'attendance' then
    return private.fail('invalid_link', 'Use the registration link controls for that link.');
  end if;

  result := public.admin_create_volunteer_link(old.event_id, old.label, p_expires_at, old.allow_walkins);
  if (result ->> 'ok')::boolean then
    update public.volunteer_access set revoked_at = coalesce(revoked_at, now()) where id = p_access_id;
  end if;
  return result;
end;
$$;

drop function if exists public.admin_set_attendance(uuid, boolean);

create or replace function public.admin_set_attendance(
  p_registration_id uuid,
  p_present boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  r public.registrations;
begin
  perform private.require_staff();

  select * into r from public.registrations where id = p_registration_id and status = 'registered';
  if not found then
    return private.fail('not_found', 'Registration not found.');
  end if;

  return private.set_attendance(r.event_id, r.person_id, p_present, p_reason, 'admin:' || auth.uid()::text);
end;
$$;

create or replace function public.admin_cancel_registration(p_registration_id uuid)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  r public.registrations;
begin
  perform private.require_admin();

  update public.registrations set status = 'cancelled'
  where id = p_registration_id and status = 'registered'
  returning * into r;

  if r.id is null then
    return private.fail('not_found', 'Registration not found.');
  end if;

  -- Keep a copy of any attendance that is removed with the registration.
  insert into public.attendance_corrections
    (actor, action, event_id, person_id, registration_id, classification, method,
     original_checked_in_at, original_checked_in_by, reason)
  select 'admin:' || auth.uid()::text, 'removed', a.event_id, a.person_id, a.registration_id,
         a.classification, a.method, a.checked_in_at, a.checked_in_by, 'Registration cancelled'
  from public.attendance a where a.registration_id = r.id;
  delete from public.attendance where registration_id = r.id;
  perform private.audit('admin:' || auth.uid()::text, 'registration_cancelled', r.event_id,
    jsonb_build_object('registration_id', r.id));
  return jsonb_build_object('ok', true);
end;
$$;

-- Paged, searchable, filterable participant list for one event.
create or replace function public.admin_list_registrations(
  p_event_id uuid,
  p_search text default '',
  p_filter text default 'all',
  p_sort text default 'created_desc',
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  ev public.events;
  s text := lower(btrim(coalesce(p_search, '')));
  s_digits text := regexp_replace(regexp_replace(coalesce(p_search, ''), '[^0-9]', '', 'g'), '^0+', '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 5000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
  v_rows jsonb;
  ended boolean;
begin
  perform private.require_staff();

  select * into ev from public.events where id = p_event_id;
  if not found then
    return private.fail('not_found', 'Event not found.');
  end if;
  ended := now() > private.event_end_at(ev);

  with base as (
    select
      r.id, r.full_name,
      case when private.is_admin_user() then r.email end as email,
      case when private.is_admin_user() then r.phone else private.mask_phone(r.phone) end as phone,
      r.church_name, r.registration_reference,
      r.status, r.created_at, a.checked_in_at, a.method as check_in_method,
      r.person_id, r.classification
    from public.registrations r
    left join public.attendance a on a.registration_id = r.id
    where r.event_id = p_event_id
      and (
        s = ''
        or lower(r.full_name) like '%' || private.escape_like(s) || '%' escape '\'
        or lower(r.email) like '%' || private.escape_like(s) || '%' escape '\'
        or lower(r.church_name) like '%' || private.escape_like(s) || '%' escape '\'
        or (char_length(s_digits) >= 3 and r.phone like '%' || s_digits || '%')
      )
      and case coalesce(p_filter, 'all')
            when 'present' then r.status = 'registered' and a.id is not null
            when 'not_checked_in' then r.status = 'registered' and a.id is null
            when 'absent' then r.status = 'registered' and a.id is null and ended
            when 'cancelled' then r.status = 'cancelled'
            else r.status = 'registered'
          end
  )
  select count(*) into v_total from base;

  with base as (
    select
      r.id, r.full_name,
      case when private.is_admin_user() then r.email end as email,
      case when private.is_admin_user() then r.phone else private.mask_phone(r.phone) end as phone,
      r.church_name, r.registration_reference,
      r.status, r.created_at, a.checked_in_at, a.method as check_in_method,
      r.person_id, r.classification
    from public.registrations r
    left join public.attendance a on a.registration_id = r.id
    where r.event_id = p_event_id
      and (
        s = ''
        or lower(r.full_name) like '%' || private.escape_like(s) || '%' escape '\'
        or lower(r.email) like '%' || private.escape_like(s) || '%' escape '\'
        or lower(r.church_name) like '%' || private.escape_like(s) || '%' escape '\'
        or (char_length(s_digits) >= 3 and r.phone like '%' || s_digits || '%')
      )
      and case coalesce(p_filter, 'all')
            when 'present' then r.status = 'registered' and a.id is not null
            when 'not_checked_in' then r.status = 'registered' and a.id is null
            when 'absent' then r.status = 'registered' and a.id is null and ended
            when 'cancelled' then r.status = 'cancelled'
            else r.status = 'registered'
          end
  ), ordered as (
    select * from base
    order by
      case when p_sort = 'name_asc' then lower(full_name) end asc,
      case when p_sort = 'name_desc' then lower(full_name) end desc,
      case when p_sort = 'church_asc' then lower(church_name) end asc,
      case when p_sort = 'created_asc' then created_at end asc,
      case when p_sort = 'checkin_desc' then checked_in_at end desc nulls last,
      created_at desc
    limit v_limit offset v_offset
  ), numbered as (
    select o.*, row_number() over () as rn from ordered o
  )
  select coalesce(jsonb_agg(to_jsonb(n) - 'rn' order by n.rn), '[]'::jsonb) into v_rows from numbered n;

  return jsonb_build_object('ok', true, 'total', v_total, 'event_ended', ended, 'rows', v_rows);
end;
$$;

-- One event's report: totals and a church-by-church breakdown.
create or replace function private.event_totals(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'event_id', e.id,
    'name', e.name,
    'venue', e.venue,
    'event_date', e.event_date,
    'start_time', e.start_time,
    'end_date', e.end_date,
    'end_time', e.end_time,
    'status', e.status,
    'capacity', e.capacity,
    'completed', now() > private.event_end_at(e),
    'registrations', t.valid,
    'attendees', t.present,
    'not_checked_in', t.valid - t.present,
    'absentees', case when now() > private.event_end_at(e) then t.valid - t.present end,
    'remaining_capacity', greatest(e.capacity - t.valid, 0),
    'attendance_percentage',
      case when t.valid = 0 then 0 else round(100.0 * t.present / t.valid, 1) end,
    'cancelled_registrations', t.cancelled,
    'members_attended', (select count(*) from public.attendance a where a.event_id = e.id and a.classification = 'member'),
    'visitors_attended', (select count(*) from public.attendance a where a.event_id = e.id and a.classification = 'visitor'),
    'unique_attendees', (select count(*) from public.attendance a where a.event_id = e.id),
    'category', e.category,
    'visibility', e.visibility
  )
  from public.events e
  cross join lateral (
    select
      count(*) filter (where r.status = 'registered')::integer as valid,
      count(*) filter (where r.status = 'registered' and a.id is not null)::integer as present,
      count(*) filter (where r.status = 'cancelled')::integer as cancelled
    from public.registrations r
    left join public.attendance a on a.registration_id = r.id
    where r.event_id = e.id
  ) t
  where e.id = p_event_id
$$;

create or replace function public.admin_event_report(p_event_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  totals jsonb;
  churches jsonb;
begin
  perform private.require_staff();

  totals := private.event_totals(p_event_id);
  if totals is null then
    return private.fail('not_found', 'Event not found.');
  end if;

  select coalesce(jsonb_agg(c order by c.registered desc, c.church_name), '[]'::jsonb) into churches
  from (
    select
      min(r.church_name) as church_name,
      count(*)::integer as registered,
      count(a.id)::integer as attended,
      case when count(*) = 0 then 0 else round(100.0 * count(a.id) / count(*), 1) end as percentage
    from public.registrations r
    left join public.attendance a on a.registration_id = r.id
    where r.event_id = p_event_id and r.status = 'registered'
    group by lower(btrim(r.church_name))
  ) c;

  return jsonb_build_object('ok', true, 'report', totals, 'churches', churches);
end;
$$;

create or replace function public.admin_reports_overview()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  rows jsonb;
begin
  perform private.require_staff();

  select coalesce(jsonb_agg(private.event_totals(e.id) order by e.event_date desc, e.start_time desc), '[]'::jsonb)
  into rows
  from public.events e;

  return jsonb_build_object('ok', true, 'events', rows);
end;
$$;

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  today date := (now() at time zone private.event_tz())::date;
begin
  perform private.require_admin();

  return jsonb_build_object(
    'ok', true,
    'total_events', (select count(*) from public.events),
    'upcoming_events', (select count(*) from public.events
                        where status = 'published' and coalesce(end_date, event_date) >= today),
    'total_members', (select count(*) from public.people where kind = 'member' and status = 'active'),
    'total_visitors', (select count(*) from public.people where kind = 'visitor'),
    'total_registrations', (select count(*) from public.registrations where status = 'registered'),
    'total_attendees', (select count(*) from public.attendance a
                        join public.registrations r on r.id = a.registration_id
                        where r.status = 'registered'),
    -- Absentees only exist once an event has finished.
    'total_absentees', (
      select coalesce(sum((private.event_totals(e.id) ->> 'absentees')::integer), 0)
      from public.events e
      where e.status = 'published' and now() > private.event_end_at(e)
    )
  );
end;
$$;

-- =============================================================================
-- Members, visitors, event links and attendance (enhancement)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Who is the signed-in user? Administrators do everything; managers handle
-- attendance and reports. (Roles are granted in the SQL editor only.)
-- ---------------------------------------------------------------------------
create or replace function public.is_staff()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.admin_roles where user_id = auth.uid() and role in ('admin', 'manager'))
$$;

create or replace function public.my_role()
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select role from public.admin_roles where user_id = auth.uid()
$$;

create or replace function private.require_staff()
returns void
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
     or not exists (select 1 from public.admin_roles where user_id = auth.uid() and role in ('admin', 'manager')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------
-- M-00012 for members, V-00012 for visitors. The number never changes, so a
-- visitor who becomes a member keeps the same number.
create or replace function private.person_label(p public.people)
returns text
language sql
immutable
as $$ select (case when p.kind = 'member' then 'M-' else 'V-' end) || lpad(p.person_no::text, 5, '0') $$;

create or replace function private.mask_phone(p_phone text)
returns text
language sql
immutable
as $$ select '••• ••• ' || right(coalesce(p_phone, ''), 3) $$;

-- Two names "look like the same person" when they share enough words.
create or replace function private.name_tokens(p text)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(distinct t), '{}')
  from unnest(regexp_split_to_array(lower(regexp_replace(coalesce(p, ''), '[^[:alnum:][:space:]]', ' ', 'g')), '\s+')) as t
  where t <> ''
$$;

create or replace function private.names_compatible(a text, b text)
returns boolean
language plpgsql
immutable
as $$
declare
  ta text[] := private.name_tokens(a);
  tb text[] := private.name_tokens(b);
  common integer;
begin
  if cardinality(ta) = 0 or cardinality(tb) = 0 then
    return false;
  end if;
  select count(*) into common from unnest(ta) x where x = any (tb);
  return common >= least(2, cardinality(ta), cardinality(tb));
end;
$$;

-- Stricter: both names need at least two words (so "Mary" never matches every Mary).
create or replace function private.names_similar(a text, b text)
returns boolean
language sql
immutable
as $$
  select cardinality(private.name_tokens(a)) >= 2
     and cardinality(private.name_tokens(b)) >= 2
     and private.names_compatible(a, b)
$$;

create or replace function private.person_summary(p public.people, p_mask boolean default false)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'id', p.id,
    'label', private.person_label(p),
    'kind', p.kind,
    'membership_type', p.membership_type,
    'full_name', p.full_name,
    'phone', case when p_mask then private.mask_phone(p.phone) else p.phone end,
    'email', p.email,
    'status', p.status
  )
$$;

create or replace function private.is_admin_user()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$ select exists (select 1 from public.admin_roles where user_id = auth.uid() and role = 'admin') $$;

-- A readable "who recorded it" for reports.
create or replace function private.recorded_by(p_by text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_by like 'admin:%' then
      coalesce((select u.email from auth.users u where u.id::text = substr(p_by, 7)), 'Administrator')
    when p_by like 'volunteer:%' then
      coalesce((select va.label from public.volunteer_access va where va.id::text = substr(p_by, 11)), 'Usher')
    else coalesce(p_by, '')
  end
$$;

-- Finds the person with this phone number, or creates a visitor. An existing
-- person is never overwritten or merged: if the name given is quite different it
-- is only flagged for an administrator to review.
create or replace function private.find_or_create_visitor(
  p_name text, p_phone text, p_email text, p_church text, p_actor text
)
returns public.people
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  p public.people;
begin
  select * into p from public.people where phone = p_phone;

  if found then
    if not private.names_compatible(p.full_name, p_name) and not p.needs_review then
      update public.people
      set needs_review = true,
          review_note = left(format('Also used the name "%s" with the same phone number.', p_name), 500)
      where id = p.id
      returning * into p;
    end if;
    if (p.email is null and nullif(p_email, '') is not null)
       or (p.church_name is null and nullif(p_church, '') is not null) then
      update public.people
      set email = coalesce(email, nullif(p_email, '')),
          church_name = coalesce(church_name, nullif(p_church, ''))
      where id = p.id
      returning * into p;
    end if;
    return p;
  end if;

  insert into public.people (kind, full_name, phone, email, church_name, created_by)
  values ('visitor', p_name, p_phone, nullif(p_email, ''), nullif(p_church, ''), coalesce(p_actor, 'system'))
  on conflict (phone) do nothing
  returning * into p;

  if p.id is null then
    select * into p from public.people where phone = p_phone;  -- lost a race: use the winner
  end if;
  return p;
end;
$$;

-- Registrations and attendance are always attached to a person, even when they are
-- inserted directly by older code or by an administrator in the SQL editor.
create or replace function private.registrations_link_person()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.people;
begin
  if new.person_id is null then
    p := private.find_or_create_visitor(new.full_name, new.phone, new.email, new.church_name, 'registration');
    new.person_id := p.id;
  end if;
  if new.classification is null then
    select case when kind = 'member' then 'member' else 'visitor' end
    into new.classification from public.people where id = new.person_id;
  end if;
  return new;
end;
$$;

drop trigger if exists registrations_link_person on public.registrations;
create trigger registrations_link_person
  before insert on public.registrations
  for each row execute function private.registrations_link_person();

-- membership_type "visitor" and kind "visitor" always go together, whoever writes the row.
create or replace function private.people_sync_type()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'visitor' then
    new.membership_type := 'visitor';
  elsif new.membership_type = 'visitor' then
    -- A member can only have a member type: keep the one they already had.
    new.membership_type := case when tg_op = 'UPDATE' and old.kind = 'member' then old.membership_type else 'member' end;
  end if;
  return new;
end;
$$;

drop trigger if exists people_sync_type on public.people;
create trigger people_sync_type
  before insert or update on public.people
  for each row execute function private.people_sync_type();

create or replace function private.attendance_fill()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.person_id is null and new.registration_id is not null then
    select person_id into new.person_id from public.registrations where id = new.registration_id;
  end if;
  -- What the person IS at the moment they are marked present, kept for good.
  if new.classification is null and new.person_id is not null then
    select case when kind = 'member' then 'member' else 'visitor' end
    into new.classification from public.people where id = new.person_id;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_fill on public.attendance;
create trigger attendance_fill
  before insert on public.attendance
  for each row execute function private.attendance_fill();

-- ---------------------------------------------------------------------------
-- Event links: every event gets a registration link and an attendance link
-- when it is created, and the attendance link follows the event's dates.
-- ---------------------------------------------------------------------------
create or replace function private.events_create_links()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t1 text := private.new_token();
  t2 text := private.new_token();
begin
  insert into public.volunteer_access (event_id, kind, token_hash, token_plain, label, expires_at, auto_managed)
  values (new.id, 'registration', private.hash_token(t1), t1, 'Registration link', null, true);

  insert into public.volunteer_access (event_id, kind, token_hash, token_plain, label, expires_at, auto_managed)
  values (new.id, 'attendance', private.hash_token(t2), t2, 'Ushers', private.event_end_at(new) + interval '3 days', true);
  return new;
end;
$$;

drop trigger if exists events_create_links on public.events;
create trigger events_create_links
  after insert on public.events
  for each row execute function private.events_create_links();

create or replace function private.events_move_link_expiry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.volunteer_access
  set expires_at = private.event_end_at(new) + interval '3 days'
  where event_id = new.id and kind = 'attendance' and auto_managed and revoked_at is null;
  return new;
end;
$$;

drop trigger if exists events_move_link_expiry on public.events;
create trigger events_move_link_expiry
  after update of event_date, end_date, end_time on public.events
  for each row execute function private.events_move_link_expiry();

-- Events that existed before this enhancement get their two links too. (A loop, so
-- that every event gets its own random token.)
do $$
declare
  ev public.events;
  t text;
begin
  for ev in
    select e.* from public.events e
    where not exists (
      select 1 from public.volunteer_access v
      where v.event_id = e.id and v.kind = 'registration' and v.revoked_at is null)
  loop
    t := private.new_token();
    insert into public.volunteer_access (event_id, kind, token_hash, token_plain, label, expires_at, auto_managed)
    values (ev.id, 'registration', private.hash_token(t), t, 'Registration link', null, true);
  end loop;

  for ev in
    select e.* from public.events e
    where not exists (
      select 1 from public.volunteer_access v
      where v.event_id = e.id and v.kind = 'attendance' and v.auto_managed)
  loop
    t := private.new_token();
    insert into public.volunteer_access (event_id, kind, token_hash, token_plain, label, expires_at, auto_managed)
    values (ev.id, 'attendance', private.hash_token(t), t, 'Ushers', private.event_end_at(ev) + interval '3 days', true);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Registration through an event's secret registration link
-- ---------------------------------------------------------------------------
create or replace function private.resolve_registration_link(p_token text)
returns table (event_id uuid, state text)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  va public.volunteer_access;
  ev public.events;
  ip text := private.client_ip();
begin
  event_id := null;

  if private.failure_count('vol-bad:' || ip, 'bad-token', interval '10 minutes') >= 20 then
    state := 'rate_limited'; return next; return;
  end if;
  if p_token is null or char_length(p_token) < 20 or char_length(p_token) > 200 then
    insert into private.rate_limits (key, action) values ('vol-bad:' || ip, 'bad-token');
    state := 'invalid'; return next; return;
  end if;

  select * into va from public.volunteer_access
  where token_hash = private.hash_token(p_token) and kind = 'registration';
  if not found then
    insert into private.rate_limits (key, action) values ('vol-bad:' || ip, 'bad-token');
    state := 'invalid'; return next; return;
  end if;
  if va.revoked_at is not null then
    state := 'revoked'; return next; return;
  end if;
  if va.expires_at is not null and va.expires_at <= now() then
    state := 'expired'; return next; return;
  end if;

  select * into ev from public.events where id = va.event_id;
  if not found or ev.status <> 'published' then
    state := 'event_unavailable'; return next; return;
  end if;

  event_id := va.event_id;
  state := 'ok';
  return next;
end;
$$;

create or replace function private.registration_link_error(p_state text)
returns jsonb
language sql
immutable
as $$
  select case p_state
    when 'revoked' then private.fail('revoked', 'This registration link is no longer active. Please ask the organisers for the current link.')
    when 'expired' then private.fail('expired', 'This registration link has expired. Please ask the organisers for a new one.')
    when 'event_unavailable' then private.fail('event_unavailable', 'This event is not available for registration.')
    when 'rate_limited' then private.fail('rate_limited', 'Too many requests. Please wait a moment and try again.')
    else private.fail('invalid_link', 'This registration link is not valid.')
  end
$$;

-- What the registration page may show for a link: only this event's basic details.
create or replace function public.registration_link_event(p_token text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
  ev public.events;
  taken integer;
  v_state text;
begin
  select * into v from private.resolve_registration_link(p_token);
  if v.state <> 'ok' then
    return private.registration_link_error(v.state);
  end if;

  select * into ev from public.events where id = v.event_id;
  select count(*) into taken from public.registrations where event_id = ev.id and status = 'registered';

  v_state := case
    when now() > private.event_end_at(ev) then 'ended'
    when not ev.registration_enabled then 'unavailable'
    when ev.registration_opens_at is not null and now() < ev.registration_opens_at then 'not_open'
    when ev.registration_closes_at is not null and now() > ev.registration_closes_at then 'closed'
    when taken >= ev.capacity then 'full'
    else 'open'
  end;

  return jsonb_build_object(
    'ok', true,
    'event', jsonb_build_object(
      'name', ev.name, 'description', ev.description, 'venue', ev.venue,
      'event_date', ev.event_date, 'start_time', ev.start_time,
      'end_date', ev.end_date, 'end_time', ev.end_time,
      'registration_state', v_state,
      'spots_remaining', case when ev.show_remaining then greatest(ev.capacity - taken, 0) end
    )
  );
end;
$$;

create or replace function public.register_via_link(
  p_token text,
  p_full_name text,
  p_email text,
  p_phone text,
  p_church_name text,
  p_consent boolean default false
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  select * into v from private.resolve_registration_link(p_token);
  if v.state <> 'ok' then
    return private.registration_link_error(v.state);
  end if;
  return private.do_register(v.event_id, p_full_name, p_email, p_phone, p_church_name, p_consent, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Link management (administrators)
-- ---------------------------------------------------------------------------
create or replace function public.admin_event_links(p_event_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  ev public.events;
  v_reg jsonb;
  v_att jsonb;
begin
  perform private.require_admin();
  select * into ev from public.events where id = p_event_id;
  if not found then
    return private.fail('not_found', 'Event not found.');
  end if;

  select to_jsonb(r) into v_reg
  from (
    select id, token_plain as token, expires_at, last_used_at, created_at
    from public.volunteer_access
    where event_id = p_event_id and kind = 'registration' and revoked_at is null
    limit 1
  ) r;

  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc), '[]'::jsonb) into v_att
  from (
    select id, label, token_plain as token, expires_at, revoked_at, last_used_at,
           allow_walkins, auto_managed, created_at,
           (revoked_at is null and (expires_at is null or expires_at > now())) as active
    from public.volunteer_access
    where event_id = p_event_id and kind = 'attendance'
  ) a;

  return jsonb_build_object(
    'ok', true,
    'event', jsonb_build_object(
      'id', ev.id, 'name', ev.name, 'visibility', ev.visibility, 'status', ev.status,
      'registration_enabled', ev.registration_enabled, 'attendance_enabled', ev.attendance_enabled,
      'ended', now() > private.event_end_at(ev)
    ),
    'registration_link', v_reg,
    'attendance_links', v_att
  );
end;
$$;

-- action: 'create' (keeps the current link if there is one), 'regenerate' (the old
-- link stops working at once) or 'disable' (no registration link until one is created).
create or replace function public.admin_registration_link(
  p_event_id uuid,
  p_action text,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_token text;
  v_id uuid;
begin
  perform private.require_admin();
  if not exists (select 1 from public.events where id = p_event_id) then
    return private.fail('not_found', 'Event not found.');
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    return private.fail('invalid_expiry', 'The expiry must be in the future.');
  end if;

  if p_action = 'disable' then
    update public.volunteer_access set revoked_at = now()
    where event_id = p_event_id and kind = 'registration' and revoked_at is null;
    perform private.audit('admin:' || auth.uid()::text, 'registration_link_disabled', p_event_id, '{}'::jsonb);
    return jsonb_build_object('ok', true);
  end if;

  if p_action = 'create' and exists (
    select 1 from public.volunteer_access where event_id = p_event_id and kind = 'registration' and revoked_at is null
  ) then
    return jsonb_build_object('ok', true, 'unchanged', true);
  end if;

  if p_action not in ('create', 'regenerate') then
    return private.fail('invalid_action', 'Unknown action.');
  end if;

  update public.volunteer_access set revoked_at = now()
  where event_id = p_event_id and kind = 'registration' and revoked_at is null;

  v_token := private.new_token();
  insert into public.volunteer_access (event_id, kind, token_hash, token_plain, label, expires_at, auto_managed)
  values (p_event_id, 'registration', private.hash_token(v_token), v_token, 'Registration link', p_expires_at, false)
  returning id into v_id;

  perform private.audit('admin:' || auth.uid()::text,
    case when p_action = 'create' then 'registration_link_created' else 'registration_link_regenerated' end,
    p_event_id, jsonb_build_object('link_id', v_id));
  return jsonb_build_object('ok', true, 'id', v_id, 'token', v_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- Usher functions: attendance of members and visitors through an attendance link
-- ---------------------------------------------------------------------------
create or replace function private.check_in_gate(ev public.events)
returns jsonb
language plpgsql
stable
as $$
begin
  if not ev.attendance_enabled then
    return private.fail('attendance_disabled', 'Attendance is not being recorded for this event.');
  end if;
  -- Check-in opens a week before the event (so ushers can rehearse and test) and
  -- closes one day after it ends. Times are shown in Nairobi time.
  if now() < private.event_start_at(ev) - interval '7 days'
     or now() > private.event_end_at(ev) + interval '1 day' then
    return private.fail(
      'outside_window',
      format(
        'Check-in for "%s" is open from %s until %s (Nairobi time).',
        ev.name,
        to_char((private.event_start_at(ev) - interval '7 days') at time zone private.event_tz(), 'FMDD Mon YYYY, FMHH12:MI AM'),
        to_char((private.event_end_at(ev) + interval '1 day') at time zone private.event_tz(), 'FMDD Mon YYYY, FMHH12:MI AM')
      )
    );
  end if;
  return null;
end;
$$;

-- Marks a person present for an event. Safe to call twice and from many ushers at
-- once: the unique key on (event, person) decides, so nobody is counted twice.
create or replace function private.do_check_in_person(
  p_event_id uuid,
  p_person_id uuid,
  p_method text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  p public.people;
  ev public.events;
  gate jsonb;
  v_reg uuid;
  v_inserted uuid;
  v_at timestamptz;
begin
  select * into p from public.people where id = p_person_id;
  if not found or p.status <> 'active' then
    return private.fail('not_found', 'That person was not found. Search again, or register them as a new visitor.');
  end if;

  select * into ev from public.events where id = p_event_id;
  gate := private.check_in_gate(ev);
  if gate is not null then
    return gate;
  end if;

  -- If they registered for this event, record the attendance against that registration.
  select id into v_reg from public.registrations
  where event_id = p_event_id and person_id = p.id and status = 'registered';

  insert into public.attendance (registration_id, person_id, classification, event_id, method, checked_in_by)
  values (v_reg, p.id, case when p.kind = 'member' then 'member' else 'visitor' end, p_event_id, p_method, p_actor)
  on conflict do nothing
  returning id into v_inserted;

  if v_inserted is not null then
    perform private.audit(p_actor, 'check_in', p_event_id,
      jsonb_build_object('person_id', p.id, 'kind', p.kind, 'method', p_method));
    return jsonb_build_object('ok', true, 'result', 'checked_in', 'full_name', p.full_name,
                              'kind', p.kind, 'label', private.person_label(p), 'checked_in_at', now());
  end if;

  select checked_in_at into v_at from public.attendance where event_id = p_event_id and person_id = p.id;
  return jsonb_build_object('ok', true, 'result', 'already_checked_in', 'full_name', p.full_name,
                            'kind', p.kind, 'label', private.person_label(p), 'checked_in_at', v_at);
end;
$$;

create or replace function public.volunteer_search_people(p_token text, p_query text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
  q text;
  digits text;
  results jsonb;
begin
  select * into v from private.resolve_volunteer(p_token);
  if v.state <> 'ok' then
    return private.volunteer_error(v.state);
  end if;

  q := btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g'));
  if char_length(q) < 3 then
    return private.fail('query_too_short', 'Type at least 3 characters.');
  end if;
  q := left(q, 60);

  digits := regexp_replace(regexp_replace(q, '[^0-9]', '', 'g'), '^0+', '');

  select coalesce(jsonb_agg(row_to_json(m)::jsonb order by m.full_name), '[]'::jsonb) into results
  from (
    select
      p.id as person_id,
      private.person_label(p) as label,
      p.kind,
      p.membership_type,
      p.full_name,
      private.mask_phone(p.phone) as phone_hint,
      exists (select 1 from public.registrations r
              where r.event_id = v.event_id and r.person_id = p.id and r.status = 'registered') as registered,
      (a.id is not null) as checked_in,
      a.checked_in_at
    from public.people p
    left join public.attendance a on a.event_id = v.event_id and a.person_id = p.id
    where p.status = 'active'
      and (
        lower(p.full_name) like '%' || lower(private.escape_like(q)) || '%' escape '\'
        or (char_length(digits) >= 4 and (p.phone like '%' || digits || '%' or p.alt_phone like '%' || digits || '%'))
      )
    order by p.full_name
    limit 12
  ) m;

  return jsonb_build_object('ok', true, 'results', results);
end;
$$;

create or replace function public.volunteer_check_in_person(p_token text, p_person_id uuid)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  select * into v from private.resolve_volunteer(p_token);
  if v.state <> 'ok' then
    return private.volunteer_error(v.state);
  end if;
  return private.do_check_in_person(v.event_id, p_person_id, 'search', 'volunteer:' || v.access_id::text);
end;
$$;

-- Someone arrives without having registered: the usher captures name and phone, and
-- the person is registered as a visitor and marked present in one step.
create or replace function public.volunteer_register_walkin(
  p_token text,
  p_full_name text,
  p_phone text,
  p_church_name text default null,
  p_email text default null,
  p_consent boolean default false
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
  v_name text := btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
  v_phone text := private.normalize_phone(p_phone);
  v_church text := nullif(btrim(regexp_replace(coalesce(p_church_name, ''), '\s+', ' ', 'g')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  existing public.people;
  p public.people;
  res jsonb;
begin
  select * into v from private.resolve_volunteer(p_token);
  if v.state <> 'ok' then
    return private.volunteer_error(v.state);
  end if;

  if not v.allow_walkins then
    return private.fail('walkins_not_allowed', 'This link cannot register new visitors. Ask an administrator.');
  end if;
  if not private.rate_limit('walkin:' || v.access_id::text, 'walkin', 60, interval '1 hour') then
    return private.fail('rate_limited', 'Too many new visitors registered from this link. Please try again later.');
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 100 then
    return private.fail('invalid_name', 'Enter the visitor''s full name.');
  end if;
  if v_phone !~ '^\+[0-9]{9,15}$' then
    return private.fail('invalid_phone', 'Enter a valid phone number, for example 0712 345 678.');
  end if;
  if v_email is not null
     and (char_length(v_email) > 254 or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return private.fail('invalid_email', 'That email address does not look right.');
  end if;
  if v_church is not null and char_length(v_church) > 150 then
    return private.fail('invalid_church', 'The church name is too long.');
  end if;
  if p_consent is not true then
    return private.fail('consent_required', 'Confirm that the visitor agrees to their details being recorded.');
  end if;

  -- The window must be open before anyone is created.
  res := private.check_in_gate((select e from public.events e where e.id = v.event_id));
  if res is not null then
    return res;
  end if;

  select * into existing from public.people where phone = v_phone;
  p := private.find_or_create_visitor(v_name, v_phone, v_email, v_church, 'walkin:' || v.access_id::text);

  res := private.do_check_in_person(v.event_id, p.id, 'walkin', 'volunteer:' || v.access_id::text);
  if (res ->> 'ok')::boolean then
    res := res || jsonb_build_object('matched_existing', existing.id is not null);
    perform private.audit('volunteer:' || v.access_id::text, 'walkin_registered', v.event_id,
      jsonb_build_object('person_id', p.id, 'new_person', existing.id is null));
  end if;
  return res;
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff corrections: marking present / removing attendance by hand. Removed records
-- are copied to attendance_corrections first, so history is never lost.
-- ---------------------------------------------------------------------------
create or replace function private.set_attendance(
  p_event_id uuid,
  p_person_id uuid,
  p_present boolean,
  p_reason text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  p public.people;
  a public.attendance;
  v_reg uuid;
  v_inserted uuid;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  select * into p from public.people where id = p_person_id;
  if not found or not exists (select 1 from public.events where id = p_event_id) then
    return private.fail('not_found', 'Person or event not found.');
  end if;

  if p_present then
    select id into v_reg from public.registrations
    where event_id = p_event_id and person_id = p.id and status = 'registered';

    insert into public.attendance (registration_id, person_id, classification, event_id, method, checked_in_by)
    values (v_reg, p.id, case when p.kind = 'member' then 'member' else 'visitor' end, p_event_id, 'admin', p_actor)
    on conflict do nothing
    returning id into v_inserted;

    if v_inserted is not null then
      insert into public.attendance_corrections (actor, action, event_id, person_id, registration_id, classification, method, reason)
      values (p_actor, 'added', p_event_id, p.id, v_reg, case when p.kind = 'member' then 'member' else 'visitor' end, 'admin', v_reason);
      perform private.audit(p_actor, 'attendance_marked', p_event_id, jsonb_build_object('person_id', p.id));
      return jsonb_build_object('ok', true, 'result', 'checked_in');
    end if;
    return jsonb_build_object('ok', true, 'result', 'already_checked_in');
  end if;

  select * into a from public.attendance where event_id = p_event_id and person_id = p.id;
  if not found then
    return jsonb_build_object('ok', true, 'result', 'not_present');
  end if;

  insert into public.attendance_corrections
    (actor, action, event_id, person_id, registration_id, classification, method,
     original_checked_in_at, original_checked_in_by, reason)
  values
    (p_actor, 'removed', a.event_id, a.person_id, a.registration_id, a.classification, a.method,
     a.checked_in_at, a.checked_in_by, v_reason);
  delete from public.attendance where id = a.id;
  perform private.audit(p_actor, 'attendance_cleared', p_event_id, jsonb_build_object('person_id', p.id));
  return jsonb_build_object('ok', true, 'result', 'removed');
end;
$$;

create or replace function public.admin_set_person_attendance(
  p_event_id uuid,
  p_person_id uuid,
  p_present boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  perform private.require_staff();
  return private.set_attendance(p_event_id, p_person_id, p_present, p_reason, 'admin:' || auth.uid()::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- Members and visitors (administrators)
-- ---------------------------------------------------------------------------
create or replace function private.clean_text(p text, p_max integer)
returns text
language sql
immutable
as $$ select left(nullif(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), ''), p_max) $$;

create or replace function private.possible_duplicates(
  p_name text, p_phone text, p_alt_phone text, p_email text, p_exclude uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(m order by (m ->> 'full_name')), '[]'::jsonb)
  from (
    select private.person_summary(p) || jsonb_build_object(
      'reasons',
      to_jsonb(array_remove(array[
        case when p.phone = p_phone or p.alt_phone = p_phone
                  or (p_alt_phone is not null and (p.phone = p_alt_phone or p.alt_phone = p_alt_phone))
             then 'same_phone' end,
        case when p_email is not null and lower(p.email) = lower(p_email) then 'same_email' end,
        case when private.names_similar(p.full_name, p_name) then 'similar_name' end
      ], null))
    ) as m
    from public.people p
    where (p_exclude is null or p.id <> p_exclude)
      and (
        p.phone = p_phone or p.alt_phone = p_phone
        or (p_alt_phone is not null and (p.phone = p_alt_phone or p.alt_phone = p_alt_phone))
        or (p_email is not null and lower(p.email) = lower(p_email))
        or private.names_similar(p.full_name, p_name)
      )
    limit 10
  ) x
$$;

create or replace function public.admin_find_duplicates(
  p_full_name text, p_phone text, p_alt_phone text default null, p_email text default null, p_exclude uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  perform private.require_admin();
  return jsonb_build_object('ok', true, 'matches', private.possible_duplicates(
    private.clean_text(p_full_name, 100),
    private.normalize_phone(p_phone),
    case when nullif(btrim(coalesce(p_alt_phone, '')), '') is null then null else private.normalize_phone(p_alt_phone) end,
    nullif(lower(btrim(coalesce(p_email, ''))), ''),
    p_exclude));
end;
$$;

-- Validates the fields shared by "create member", "edit" and "convert".
-- p_type is the membership type; blank means "not given" (keep what the person has).
drop function if exists private.validate_person_fields(text, text, text, text, text, text, text, text);
drop function if exists private.validate_person_fields(text, text, text, text, text, text, text, text, text, text, text);

create or replace function private.validate_person_fields(
  p_full_name text, p_phone text, p_alt_phone text, p_email text, p_gender text,
  p_department text, p_church text, p_notes text,
  p_residence text default null, p_type text default null,
  out v_name text, out v_phone text, out v_alt text, out v_email text,
  out v_gender text, out v_department text, out v_church text, out v_notes text,
  out v_residence text, out v_type text,
  out v_error jsonb
)
language plpgsql
immutable
as $$
begin
  v_error := null;
  v_name := private.clean_text(p_full_name, 100);
  v_phone := private.normalize_phone(p_phone);
  v_alt := case when nullif(btrim(coalesce(p_alt_phone, '')), '') is null then null else private.normalize_phone(p_alt_phone) end;
  v_email := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_gender := nullif(lower(btrim(coalesce(p_gender, ''))), '');
  v_department := private.clean_text(p_department, 100);
  v_church := private.clean_text(p_church, 150);
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  v_residence := private.clean_text(p_residence, 150);
  v_type := nullif(lower(btrim(coalesce(p_type, ''))), '');

  if v_name is null or char_length(v_name) < 2 then
    v_error := private.fail('invalid_name', 'Enter the full name.');
  elsif v_phone !~ '^\+[0-9]{9,15}$' then
    v_error := private.fail('invalid_phone', 'Enter a valid phone number, for example 0712 345 678.');
  elsif v_alt is not null and v_alt !~ '^\+[0-9]{9,15}$' then
    v_error := private.fail('invalid_alt_phone', 'The alternative phone number does not look right.');
  elsif v_email is not null
        and (char_length(v_email) > 254 or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    v_error := private.fail('invalid_email', 'That email address does not look right.');
  elsif v_gender is not null and v_gender not in ('female', 'male', 'other') then
    v_error := private.fail('invalid_gender', 'Choose female, male or other.');
  elsif v_notes is not null and char_length(v_notes) > 1000 then
    v_error := private.fail('invalid_notes', 'Notes can be at most 1000 characters.');
  elsif v_type is not null and v_type not in ('incoming_commitment', 'in_commitment', 'member', 'visitor') then
    v_error := private.fail('invalid_type', 'Choose a membership type from the list.');
  end if;
end;
$$;

drop function if exists public.admin_create_member(text, text, text, text, text, date, text, text, text, boolean);
drop function if exists public.admin_create_member(text, text, text, text, text, date, text, text, text, boolean, text, text, text);

create or replace function public.admin_create_member(
  p_full_name text,
  p_phone text,
  p_alt_phone text default null,
  p_email text default null,
  p_gender text default null,
  p_membership_date date default null,
  p_department text default null,
  p_church text default null,
  p_notes text default null,
  p_force boolean default false,
  p_residence text default null,
  p_deaconess_id uuid default null,
  p_membership_type text default 'member'
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  f record;
  dupes jsonb;
  samephone public.people;
  p public.people;
  v_type text;
  v_kind text;
begin
  perform private.require_admin();

  select * into f from private.validate_person_fields(
    p_full_name, p_phone, p_alt_phone, p_email, p_gender, p_department, p_church, p_notes,
    p_residence, p_membership_type);
  if f.v_error is not null then
    return f.v_error;
  end if;
  v_type := coalesce(f.v_type, 'member');
  v_kind := case when v_type = 'visitor' then 'visitor' else 'member' end;
  if p_deaconess_id is not null
     and not exists (select 1 from public.deaconesses where id = p_deaconess_id and active) then
    return private.fail('invalid_deaconess', 'Choose a deaconess from the list.');
  end if;

  -- The same phone number is never registered twice: review the existing record instead.
  select * into samephone from public.people where phone = f.v_phone or alt_phone = f.v_phone;
  if found then
    return private.fail('duplicate_phone',
      format('%s (%s) is already registered with this phone number.', samephone.full_name, private.person_label(samephone)))
      || jsonb_build_object('existing', private.person_summary(samephone));
  end if;

  dupes := private.possible_duplicates(f.v_name, f.v_phone, f.v_alt, f.v_email);
  if jsonb_array_length(dupes) > 0 and not coalesce(p_force, false) then
    return private.fail('possible_duplicate',
      'Someone with a similar name or the same email is already registered. Check the list before adding another record.')
      || jsonb_build_object('matches', dupes);
  end if;

  insert into public.people
    (kind, membership_type, full_name, phone, alt_phone, email, gender, membership_date, department,
     residence, deaconess_id, church_name, notes, created_by)
  values
    (v_kind, v_type, f.v_name, f.v_phone, f.v_alt, f.v_email, f.v_gender,
     case when v_kind = 'member' then coalesce(p_membership_date, (now() at time zone private.event_tz())::date) end,
     f.v_department, f.v_residence, p_deaconess_id, f.v_church, f.v_notes, 'admin:' || auth.uid()::text)
  returning * into p;

  perform private.audit('admin:' || auth.uid()::text, 'member_created', null,
    jsonb_build_object('person_id', p.id, 'membership_type', v_type, 'forced_over_duplicates', jsonb_array_length(dupes) > 0));
  return jsonb_build_object('ok', true, 'id', p.id, 'label', private.person_label(p));
end;
$$;

-- Edits a person. Changing the membership type to or from "visitor" moves them between
-- the visitor and member lists; their registrations and attendance stay with them.
drop function if exists public.admin_update_person(uuid, text, text, text, text, text, date, text, text, text, boolean);
drop function if exists public.admin_update_person(uuid, text, text, text, text, text, date, text, text, text, boolean, text, text, text);

create or replace function public.admin_update_person(
  p_id uuid,
  p_full_name text,
  p_phone text,
  p_alt_phone text default null,
  p_email text default null,
  p_gender text default null,
  p_membership_date date default null,
  p_department text default null,
  p_church text default null,
  p_notes text default null,
  p_clear_review boolean default false,
  p_residence text default null,
  p_deaconess_id uuid default null,
  p_membership_type text default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  f record;
  cur public.people;
  other public.people;
  p public.people;
  v_type text;
  v_kind text;
begin
  perform private.require_admin();

  select * into cur from public.people where id = p_id for update;
  if not found then
    return private.fail('not_found', 'Person not found.');
  end if;

  select * into f from private.validate_person_fields(
    p_full_name, p_phone, p_alt_phone, p_email, p_gender, p_department, p_church, p_notes,
    p_residence, p_membership_type);
  if f.v_error is not null then
    return f.v_error;
  end if;
  v_type := coalesce(f.v_type, cur.membership_type);
  v_kind := case when v_type = 'visitor' then 'visitor' else 'member' end;
  if p_deaconess_id is not null
     and not exists (select 1 from public.deaconesses where id = p_deaconess_id and (active or id = cur.deaconess_id)) then
    return private.fail('invalid_deaconess', 'Choose a deaconess from the list.');
  end if;

  select * into other from public.people where (phone = f.v_phone or alt_phone = f.v_phone) and id <> p_id;
  if found then
    return private.fail('duplicate_phone',
      format('%s (%s) already has this phone number.', other.full_name, private.person_label(other)))
      || jsonb_build_object('existing', private.person_summary(other));
  end if;

  update public.people
  set full_name = f.v_name, phone = f.v_phone, alt_phone = f.v_alt, email = f.v_email, gender = f.v_gender,
      kind = v_kind, membership_type = v_type,
      membership_date = case when v_kind = 'member'
                             then coalesce(p_membership_date, cur.membership_date,
                                           case when cur.kind = 'visitor' then (now() at time zone private.event_tz())::date end)
                             else p_membership_date end,
      became_member_at = case when cur.kind = 'visitor' and v_kind = 'member' then now() else became_member_at end,
      department = f.v_department, residence = f.v_residence, deaconess_id = p_deaconess_id,
      church_name = f.v_church, notes = f.v_notes,
      needs_review = case when coalesce(p_clear_review, false) or (cur.kind = 'visitor' and v_kind = 'member') then false else needs_review end,
      review_note = case when coalesce(p_clear_review, false) or (cur.kind = 'visitor' and v_kind = 'member') then null else review_note end,
      status = case when cur.kind = 'visitor' and v_kind = 'member' then 'active' else status end
  where id = p_id
  returning * into p;

  perform private.audit('admin:' || auth.uid()::text,
    case when cur.kind = 'visitor' and v_kind = 'member' then 'visitor_converted'
         when cur.kind = 'member' and v_kind = 'visitor' then 'member_made_visitor'
         when cur.membership_type <> v_type then 'membership_type_changed'
         else 'person_updated' end,
    null,
    jsonb_build_object('person_id', p.id, 'from_type', cur.membership_type, 'to_type', v_type));
  return jsonb_build_object('ok', true, 'id', p.id, 'label', private.person_label(p));
end;
$$;

create or replace function public.admin_set_person_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  perform private.require_admin();
  if p_status not in ('active', 'inactive') then
    return private.fail('invalid_status', 'Status must be active or inactive.');
  end if;
  update public.people set status = p_status where id = p_id;
  if not found then
    return private.fail('not_found', 'Person not found.');
  end if;
  perform private.audit('admin:' || auth.uid()::text, 'person_' || p_status, null, jsonb_build_object('person_id', p_id));
  return jsonb_build_object('ok', true);
end;
$$;

-- Turns a visitor into a member of the chosen type (default: Member). It is the SAME
-- person row, so every registration and attendance record stays attached; what they were
-- at each event is kept on those records. Runs as one transaction.
drop function if exists public.admin_convert_visitor(uuid, text, text, text, text, text, date, text, text, text);
drop function if exists public.admin_convert_visitor(uuid, text, text, text, text, text, date, text, text, text, text, text, text);

create or replace function public.admin_convert_visitor(
  p_id uuid,
  p_full_name text,
  p_phone text,
  p_alt_phone text default null,
  p_email text default null,
  p_gender text default null,
  p_membership_date date default null,
  p_department text default null,
  p_church text default null,
  p_notes text default null,
  p_residence text default null,
  p_deaconess_id uuid default null,
  p_membership_type text default 'member'
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  f record;
  cur public.people;
  other public.people;
  p public.people;
  v_type text;
  n_att integer;
  n_reg integer;
begin
  perform private.require_admin();

  select * into cur from public.people where id = p_id for update;
  if not found then
    return private.fail('not_found', 'Person not found.');
  end if;
  if cur.kind = 'member' then
    return private.fail('already_member', format('%s is already a member (%s).', cur.full_name, private.person_label(cur)));
  end if;

  select * into f from private.validate_person_fields(
    p_full_name, p_phone, p_alt_phone, p_email, p_gender, p_department, p_church, p_notes,
    p_residence, p_membership_type);
  if f.v_error is not null then
    return f.v_error;
  end if;
  v_type := coalesce(f.v_type, 'member');
  if v_type = 'visitor' then
    return private.fail('invalid_type', 'Choose the membership type they are joining as (not Visitor).');
  end if;
  if p_deaconess_id is not null
     and not exists (select 1 from public.deaconesses where id = p_deaconess_id and (active or id = cur.deaconess_id)) then
    return private.fail('invalid_deaconess', 'Choose a deaconess from the list.');
  end if;

  select * into other from public.people where (phone = f.v_phone or alt_phone = f.v_phone) and id <> p_id;
  if found then
    return private.fail('duplicate_phone',
      format('%s (%s) already has this phone number.', other.full_name, private.person_label(other)))
      || jsonb_build_object('existing', private.person_summary(other));
  end if;

  update public.people
  set kind = 'member', membership_type = v_type, status = 'active', needs_review = false, review_note = null,
      full_name = f.v_name, phone = f.v_phone, alt_phone = f.v_alt, email = f.v_email, gender = f.v_gender,
      department = f.v_department, residence = f.v_residence, deaconess_id = p_deaconess_id,
      church_name = f.v_church, notes = f.v_notes,
      membership_date = coalesce(p_membership_date, (now() at time zone private.event_tz())::date),
      became_member_at = now()
  where id = p_id
  returning * into p;

  select count(*) into n_att from public.attendance where person_id = p.id;
  select count(*) into n_reg from public.registrations where person_id = p.id;

  perform private.audit('admin:' || auth.uid()::text, 'visitor_converted', null,
    jsonb_build_object('person_id', p.id, 'membership_type', v_type, 'attendance_kept', n_att, 'registrations_kept', n_reg));
  return jsonb_build_object('ok', true, 'id', p.id, 'label', private.person_label(p),
                            'attendance_kept', n_att, 'registrations_kept', n_reg);
end;
$$;

-- Distinct departments and residences already in use, for suggestions and filters.
create or replace function public.admin_person_options()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  perform private.require_admin();
  return jsonb_build_object(
    'ok', true,
    'departments', (select coalesce(jsonb_agg(d order by lower(d)), '[]'::jsonb)
                    from (select distinct department as d from public.people where department is not null limit 300) x),
    'residences', (select coalesce(jsonb_agg(d order by lower(d)), '[]'::jsonb)
                   from (select distinct residence as d from public.people where residence is not null limit 300) x)
  );
end;
$$;

-- Paged directory of members or visitors with search, type and attendance filters.
drop function if exists public.admin_list_people(text, text, text, text, date, date, text, integer, integer, boolean, integer);
drop function if exists public.admin_list_people(text, text, text, text, date, date, text, integer, integer, boolean, integer, text, text, text);

create or replace function public.admin_list_people(
  p_kind text default 'member',
  p_search text default '',
  p_status text default 'all',
  p_attended text default 'all',
  p_from date default null,
  p_to date default null,
  p_sort text default 'name_asc',
  p_limit integer default 20,
  p_offset integer default 0,
  p_review boolean default false,
  p_min_attended integer default null,
  p_type text default 'all',
  p_department text default null,
  p_deaconess_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  s text := lower(btrim(coalesce(p_search, '')));
  s_digits text := regexp_replace(regexp_replace(coalesce(p_search, ''), '[^0-9]', '', 'g'), '^0+', '');
  s_no bigint := null;
  v_dept text := nullif(lower(btrim(coalesce(p_department, ''))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 5000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
  v_rows jsonb;
begin
  perform private.require_admin();

  if s ~ '^[mv]-?[0-9]{1,9}$' then
    s_no := regexp_replace(s, '[^0-9]', '', 'g')::bigint;
  end if;

  with att as (
    select a.person_id,
           count(distinct a.event_id) filter (where e.status <> 'cancelled')::integer as attended_total,
           count(distinct a.event_id) filter (
             where e.status <> 'cancelled'
               and (p_from is null or e.event_date >= p_from)
               and (p_to is null or e.event_date <= p_to))::integer as attended_range,
           max(e.event_date) filter (where e.status <> 'cancelled') as last_attended
    from public.attendance a
    join public.events e on e.id = a.event_id
    group by a.person_id
  ), base as (
    select p.*, private.person_label(p) as label, dc.name as deaconess_name, coalesce(t.attended_total, 0) as attended_total,
           coalesce(t.attended_range, 0) as attended_range, t.last_attended,
           (select count(*) from public.registrations r where r.person_id = p.id)::integer as registrations
    from public.people p
    left join att t on t.person_id = p.id
    left join public.deaconesses dc on dc.id = p.deaconess_id
    where (p_kind = 'all' or p.kind = p_kind)
      and (p_status = 'all' or p.status = p_status)
      and (p_type is null or p_type = 'all' or p.membership_type = p_type)
      and (v_dept is null or lower(p.department) = v_dept)
      and (p_deaconess_id is null or p.deaconess_id = p_deaconess_id)
      and (not coalesce(p_review, false) or p.needs_review)
      and (
        s = ''
        or (s_no is not null and p.person_no = s_no)
        or lower(p.full_name) like '%' || private.escape_like(s) || '%' escape '\'
        or lower(coalesce(p.department, '')) like '%' || private.escape_like(s) || '%' escape '\'
        or lower(coalesce(dc.name, '')) like '%' || private.escape_like(s) || '%' escape '\'
        or lower(coalesce(p.residence, '')) like '%' || private.escape_like(s) || '%' escape '\'
        or (char_length(s_digits) >= 3 and (p.phone like '%' || s_digits || '%' or p.alt_phone like '%' || s_digits || '%'))
      )
  ), filtered as (
    select * from base b
    where (p_attended = 'all' or p_attended is null
           or (p_attended = 'none' and b.attended_range = 0)
           or (p_attended = 'some' and b.attended_range > 0))
      and (p_min_attended is null or b.attended_total >= p_min_attended)
  )
  select count(*) into v_total from filtered;

  with att as (
    select a.person_id,
           count(distinct a.event_id) filter (where e.status <> 'cancelled')::integer as attended_total,
           count(distinct a.event_id) filter (
             where e.status <> 'cancelled'
               and (p_from is null or e.event_date >= p_from)
               and (p_to is null or e.event_date <= p_to))::integer as attended_range,
           max(e.event_date) filter (where e.status <> 'cancelled') as last_attended
    from public.attendance a
    join public.events e on e.id = a.event_id
    group by a.person_id
  ), base as (
    select p.*, private.person_label(p) as label, dc.name as deaconess_name, coalesce(t.attended_total, 0) as attended_total,
           coalesce(t.attended_range, 0) as attended_range, t.last_attended,
           (select count(*) from public.registrations r where r.person_id = p.id)::integer as registrations
    from public.people p
    left join att t on t.person_id = p.id
    left join public.deaconesses dc on dc.id = p.deaconess_id
    where (p_kind = 'all' or p.kind = p_kind)
      and (p_status = 'all' or p.status = p_status)
      and (p_type is null or p_type = 'all' or p.membership_type = p_type)
      and (v_dept is null or lower(p.department) = v_dept)
      and (p_deaconess_id is null or p.deaconess_id = p_deaconess_id)
      and (not coalesce(p_review, false) or p.needs_review)
      and (
        s = ''
        or (s_no is not null and p.person_no = s_no)
        or lower(p.full_name) like '%' || private.escape_like(s) || '%' escape '\'
        or lower(coalesce(p.department, '')) like '%' || private.escape_like(s) || '%' escape '\'
        or lower(coalesce(dc.name, '')) like '%' || private.escape_like(s) || '%' escape '\'
        or lower(coalesce(p.residence, '')) like '%' || private.escape_like(s) || '%' escape '\'
        or (char_length(s_digits) >= 3 and (p.phone like '%' || s_digits || '%' or p.alt_phone like '%' || s_digits || '%'))
      )
  ), filtered as (
    select * from base b
    where (p_attended = 'all' or p_attended is null
           or (p_attended = 'none' and b.attended_range = 0)
           or (p_attended = 'some' and b.attended_range > 0))
      and (p_min_attended is null or b.attended_total >= p_min_attended)
  ), ordered as (
    select f.* from filtered f
    order by
      case when p_sort = 'name_desc' then lower(f.full_name) end desc,
      case when p_sort = 'attended_desc' then f.attended_total end desc,
      case when p_sort = 'attended_asc' then f.attended_total end asc,
      case when p_sort = 'recent_desc' then f.created_at end desc,
      case when p_sort = 'last_attended_desc' then f.last_attended end desc nulls last,
      case when p_sort = 'department_asc' then lower(coalesce(f.department, 'zzz')) end asc,
      case when p_sort = 'deaconess_asc' then lower(coalesce(f.deaconess_name, 'zzz')) end asc,
      lower(f.full_name) asc
    limit v_limit offset v_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id, 'label', o.label, 'person_no', o.person_no, 'kind', o.kind,
    'membership_type', o.membership_type,
    'full_name', o.full_name, 'phone', o.phone, 'alt_phone', o.alt_phone, 'email', o.email,
    'gender', o.gender, 'church_name', o.church_name, 'department', o.department,
    'residence', o.residence, 'deaconess_id', o.deaconess_id, 'deaconess', o.deaconess_name,
    'membership_date', o.membership_date, 'status', o.status, 'needs_review', o.needs_review,
    'review_note', o.review_note, 'notes', o.notes, 'became_member_at', o.became_member_at,
    'created_at', o.created_at, 'attended_total', o.attended_total, 'attended_range', o.attended_range,
    'last_attended', o.last_attended, 'registrations', o.registrations
  ) order by o.rn), '[]'::jsonb) into v_rows
  from (select o2.*, row_number() over () as rn from ordered o2) o;

  return jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- Deaconesses: the leaders assigned to mentor members. The administrator keeps the list;
-- members are then assigned to one by choosing from it.
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_deaconesses()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb;
begin
  perform private.require_admin();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'name', d.name, 'phone', d.phone, 'active', d.active, 'created_at', d.created_at,
    'members', (select count(*) from public.people p where p.deaconess_id = d.id and p.kind = 'member'),
    'inactive_members', (select count(*) from public.people p where p.deaconess_id = d.id and p.kind = 'member' and p.status = 'inactive')
  ) order by d.active desc, lower(d.name)), '[]'::jsonb) into v_rows
  from public.deaconesses d;
  return jsonb_build_object('ok', true, 'rows', v_rows);
end;
$$;

-- Adds a deaconess (p_id null) or edits one. Deactivating keeps her on the members she
-- already mentors but stops her being offered for new ones.
create or replace function public.admin_save_deaconess(
  p_name text,
  p_phone text default null,
  p_id uuid default null,
  p_active boolean default true
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_name text := private.clean_text(p_name, 100);
  v_phone text := case when nullif(btrim(coalesce(p_phone, '')), '') is null then null else private.normalize_phone(p_phone) end;
  other public.deaconesses;
  d public.deaconesses;
begin
  perform private.require_admin();

  if v_name is null or char_length(v_name) < 2 then
    return private.fail('invalid_name', 'Enter the deaconess''s name.');
  end if;
  if v_phone is not null and v_phone !~ '^\+[0-9]{9,15}$' then
    return private.fail('invalid_phone', 'The phone number does not look right.');
  end if;

  select * into other from public.deaconesses
  where lower(btrim(name)) = lower(v_name) and (p_id is null or id <> p_id);
  if found then
    return private.fail('duplicate_name', format('%s is already in the list.', other.name));
  end if;

  if p_id is null then
    insert into public.deaconesses (name, phone, active, created_by)
    values (v_name, v_phone, coalesce(p_active, true), 'admin:' || auth.uid()::text)
    returning * into d;
    perform private.audit('admin:' || auth.uid()::text, 'deaconess_added', null, jsonb_build_object('deaconess_id', d.id));
  else
    update public.deaconesses set name = v_name, phone = v_phone, active = coalesce(p_active, true)
    where id = p_id returning * into d;
    if d.id is null then
      return private.fail('not_found', 'Deaconess not found.');
    end if;
    perform private.audit('admin:' || auth.uid()::text, 'deaconess_updated', null, jsonb_build_object('deaconess_id', d.id));
  end if;
  return jsonb_build_object('ok', true, 'id', d.id);
end;
$$;

-- A deaconess who mentors nobody can be removed. Otherwise deactivate her instead.
create or replace function public.admin_delete_deaconess(p_id uuid)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  perform private.require_admin();
  select count(*) into n from public.people where deaconess_id = p_id;
  if n > 0 then
    return private.fail('in_use',
      format('She mentors %s member(s). Move them to another deaconess first, or deactivate her instead.', n));
  end if;
  delete from public.deaconesses where id = p_id;
  if not found then
    return private.fail('not_found', 'Deaconess not found.');
  end if;
  perform private.audit('admin:' || auth.uid()::text, 'deaconess_deleted', null, jsonb_build_object('deaconess_id', p_id));
  return jsonb_build_object('ok', true);
end;
$$;

-- One person: details, attendance history, and attendance totals per year.
create or replace function public.admin_get_person(p_id uuid, p_year integer default null)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  p public.people;
  v_year integer := coalesce(p_year, extract(year from (now() at time zone private.event_tz()))::integer);
  v_history jsonb;
  v_years jsonb;
  v_regs jsonb;
  v_year_total integer;
begin
  perform private.require_admin();
  select * into p from public.people where id = p_id;
  if not found then
    return private.fail('not_found', 'Person not found.');
  end if;

  select coalesce(jsonb_agg(h order by h.event_date desc), '[]'::jsonb) into v_history
  from (
    select e.id as event_id, e.name, e.event_date, e.category, e.status as event_status,
           a.classification, a.checked_in_at, a.method,
           private.recorded_by(a.checked_in_by) as recorded_by
    from public.attendance a
    join public.events e on e.id = a.event_id
    where a.person_id = p.id
  ) h;

  select coalesce(jsonb_agg(y order by y.year desc), '[]'::jsonb) into v_years
  from (
    select extract(year from e.event_date)::integer as year, count(distinct a.event_id)::integer as meetings
    from public.attendance a
    join public.events e on e.id = a.event_id
    where a.person_id = p.id and e.status in ('published', 'completed') and e.attendance_enabled
    group by 1
  ) y;

  select coalesce(sum((y ->> 'meetings')::integer), 0) into v_year_total
  from jsonb_array_elements(v_years) y where (y ->> 'year')::integer = v_year;

  select coalesce(jsonb_agg(r order by r.event_date desc), '[]'::jsonb) into v_regs
  from (
    select e.id as event_id, e.name, e.event_date, rg.status, rg.classification, rg.created_at,
           exists (select 1 from public.attendance a where a.event_id = e.id and a.person_id = p.id) as attended
    from public.registrations rg
    join public.events e on e.id = rg.event_id
    where rg.person_id = p.id
  ) r;

  return jsonb_build_object(
    'ok', true,
    'person', to_jsonb(p) - 'person_no' || jsonb_build_object(
      'label', private.person_label(p),
      'deaconess', (select d.name from public.deaconesses d where d.id = p.deaconess_id)),
    'year', v_year, 'year_total', v_year_total,
    'years', v_years, 'history', v_history, 'registrations', v_regs
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

-- One event: who actually attended (members and visitors apart), and who registered
-- but did not come. Each person appears under what they WERE at that event.
-- Phone numbers are hidden from managers; administrators see them in full.
create or replace function public.admin_event_attendance_report(p_event_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  ev public.events;
  v_full boolean;
  v_members jsonb;
  v_visitors jsonb;
  v_missed_members jsonb;
  v_missed_visitors jsonb;
  t jsonb;
begin
  perform private.require_staff();
  v_full := private.is_admin_user();

  select * into ev from public.events where id = p_event_id;
  if not found then
    return private.fail('not_found', 'Event not found.');
  end if;

  select coalesce(jsonb_agg(x order by x.full_name), '[]'::jsonb) into v_members
  from (
    select p.id as person_id, private.person_label(p) as label, p.full_name,
           case when v_full then p.phone else private.mask_phone(p.phone) end as phone,
           a.checked_in_at, a.method, private.recorded_by(a.checked_in_by) as recorded_by,
           (a.registration_id is not null) as registered
    from public.attendance a join public.people p on p.id = a.person_id
    where a.event_id = p_event_id and a.classification = 'member'
  ) x;

  select coalesce(jsonb_agg(x order by x.full_name), '[]'::jsonb) into v_visitors
  from (
    select p.id as person_id, private.person_label(p) as label, p.full_name,
           case when v_full then p.phone else private.mask_phone(p.phone) end as phone,
           a.checked_in_at, a.method, private.recorded_by(a.checked_in_by) as recorded_by,
           (a.registration_id is not null) as registered,
           (p.kind = 'member') as now_member
    from public.attendance a join public.people p on p.id = a.person_id
    where a.event_id = p_event_id and a.classification = 'visitor'
  ) x;

  select coalesce(jsonb_agg(x order by x.full_name), '[]'::jsonb) into v_missed_members
  from (
    select p.id as person_id, private.person_label(p) as label, p.full_name,
           case when v_full then p.phone else private.mask_phone(p.phone) end as phone
    from public.registrations r join public.people p on p.id = r.person_id
    where r.event_id = p_event_id and r.status = 'registered' and r.classification = 'member'
      and not exists (select 1 from public.attendance a where a.event_id = p_event_id and a.person_id = r.person_id)
  ) x;

  select coalesce(jsonb_agg(x order by x.full_name), '[]'::jsonb) into v_missed_visitors
  from (
    select p.id as person_id, private.person_label(p) as label, p.full_name,
           case when v_full then p.phone else private.mask_phone(p.phone) end as phone,
           (p.kind = 'member') as now_member
    from public.registrations r join public.people p on p.id = r.person_id
    where r.event_id = p_event_id and r.status = 'registered' and r.classification = 'visitor'
      and not exists (select 1 from public.attendance a where a.event_id = p_event_id and a.person_id = r.person_id)
  ) x;

  select jsonb_build_object(
    'registered', count(*) filter (where r.status = 'registered'),
    'registered_members', count(*) filter (where r.status = 'registered' and r.classification = 'member'),
    'registered_visitors', count(*) filter (where r.status = 'registered' and r.classification = 'visitor'),
    'registered_attended', count(*) filter (where r.status = 'registered' and exists (
        select 1 from public.attendance a where a.event_id = p_event_id and a.person_id = r.person_id))
  ) into t
  from public.registrations r where r.event_id = p_event_id;

  t := t || jsonb_build_object(
    'attended_members', jsonb_array_length(v_members),
    'attended_visitors', jsonb_array_length(v_visitors),
    'unique_attendees', jsonb_array_length(v_members) + jsonb_array_length(v_visitors),
    'attended_without_registering',
      (select count(*) from public.attendance a where a.event_id = p_event_id and a.registration_id is null),
    'missed_members', jsonb_array_length(v_missed_members),
    'missed_visitors', jsonb_array_length(v_missed_visitors),
    'attendance_percentage',
      case when (t ->> 'registered')::integer = 0 then null
           else round(100.0 * (t ->> 'registered_attended')::integer / (t ->> 'registered')::integer, 1) end
  );

  return jsonb_build_object(
    'ok', true,
    'full_phone_numbers', v_full,
    'event', jsonb_build_object(
      'id', ev.id, 'name', ev.name, 'venue', ev.venue, 'event_date', ev.event_date,
      'start_time', ev.start_time, 'end_date', ev.end_date, 'end_time', ev.end_time,
      'category', ev.category, 'visibility', ev.visibility, 'status', ev.status,
      'attendance_enabled', ev.attendance_enabled, 'registration_enabled', ev.registration_enabled,
      'ended', now() > private.event_end_at(ev)
    ),
    'totals', t,
    'attended_members', v_members,
    'attended_visitors', v_visitors,
    'registered_members_not_attended', v_missed_members,
    'registered_visitors_not_attended', v_missed_visitors
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Annual attendance: who came to how many meetings in a calendar year.
--
-- A "meeting" counts when it is published or completed, has attendance switched on,
-- and its DATE falls in the year (cancelled events and drafts never count). Each
-- person is counted once per meeting however many times they were checked in, and
-- registering without being checked in counts for nothing.
-- Scope: 'members' (people who are members now), 'visitors', or 'all'.
-- Ties share a rank and the next rank skips ahead (1, 2, 2, 4).
-- ---------------------------------------------------------------------------
create or replace function public.admin_annual_attendance(
  p_year integer,
  p_scope text default 'members',
  p_include_zero boolean default true,
  p_category text default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  today date := (now() at time zone private.event_tz())::date;
  v_scope text := case when p_scope in ('members', 'visitors', 'all') then p_scope else 'members' end;
  v_cat text := nullif(btrim(coalesce(p_category, '')), '');
  v_ranking jsonb;
  v_monthly jsonb;
  v_categories jsonb;
  v_summary jsonb;
  v_prev jsonb;
begin
  perform private.require_admin();
  if p_year is null or p_year < 2000 or p_year > 2100 then
    return private.fail('invalid_year', 'Choose a valid year.');
  end if;

  -- Ranking ----------------------------------------------------------------
  with meetings as (
    select e.id from public.events e
    where extract(year from e.event_date) = p_year
      and e.status in ('published', 'completed') and e.attendance_enabled
      and (v_cat is null or e.category = v_cat)
  ), counts as (
    select a.person_id, count(distinct a.event_id)::integer as meetings_attended, max(e.event_date) as last_attended
    from public.attendance a
    join meetings m on m.id = a.event_id
    join public.events e on e.id = a.event_id
    group by a.person_id
  ), pool as (
    select p.id, p.kind, p.full_name, p.phone, p.status, private.person_label(p) as label,
           coalesce(c.meetings_attended, 0) as meetings_attended, c.last_attended
    from public.people p
    left join counts c on c.person_id = p.id
    where (v_scope = 'all' or (v_scope = 'members' and p.kind = 'member') or (v_scope = 'visitors' and p.kind = 'visitor'))
      and (c.meetings_attended > 0 or (coalesce(p_include_zero, true) and p.kind = 'member' and p.status = 'active'))
  ), ranked as (
    select pool.*, rank() over (order by meetings_attended desc) as rnk from pool
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rank', r.rnk, 'person_id', r.id, 'label', r.label, 'kind', r.kind, 'full_name', r.full_name,
    'phone', r.phone, 'status', r.status, 'meetings_attended', r.meetings_attended,
    'last_attended', r.last_attended
  ) order by r.rnk, lower(r.full_name)), '[]'::jsonb) into v_ranking
  from ranked r;

  -- Summary ----------------------------------------------------------------
  with meetings as (
    select e.id, e.event_date from public.events e
    where extract(year from e.event_date) = p_year
      and e.status in ('published', 'completed') and e.attendance_enabled
      and (v_cat is null or e.category = v_cat)
  ), recs as (
    select a.person_id, a.event_id, p.kind
    from public.attendance a
    join meetings m on m.id = a.event_id
    join public.people p on p.id = a.person_id
  ), members_active as (
    select count(*)::integer as n from public.people where kind = 'member' and status = 'active'
  )
  select jsonb_build_object(
    'meetings_held', (select count(*) from meetings where event_date <= today),
    'meetings_total', (select count(*) from meetings),
    'active_members', (select n from members_active),
    'members_attended_any', (select count(distinct person_id) from recs where kind = 'member'),
    'members_attended_none',
      (select count(*) from public.people p
       where p.kind = 'member' and p.status = 'active'
         and not exists (select 1 from recs r where r.person_id = p.id)),
    'member_attendance_records', (select count(*) from recs where kind = 'member'),
    'visitors_attended_any', (select count(distinct person_id) from recs where kind = 'visitor'),
    'visitor_attendance_records', (select count(*) from recs where kind = 'visitor'),
    'participation_rate',
      case when (select count(*) from meetings where event_date <= today) > 0 and (select n from members_active) > 0
           then round(100.0 * (select count(*) from recs where kind = 'member')
                / ((select count(*) from meetings where event_date <= today) * (select n from members_active)), 1)
      end
  ) into v_summary;

  -- Attendance by month ------------------------------------------------------
  select coalesce(jsonb_agg(m order by m.month), '[]'::jsonb) into v_monthly
  from (
    select g.month,
           count(distinct e.id)::integer as meetings,
           count(a.id) filter (where p.kind = 'member')::integer as member_attendance,
           count(a.id) filter (where p.kind = 'visitor')::integer as visitor_attendance
    from generate_series(1, 12) as g(month)
    left join public.events e
      on extract(year from e.event_date) = p_year and extract(month from e.event_date) = g.month
     and e.status in ('published', 'completed') and e.attendance_enabled
     and (v_cat is null or e.category = v_cat)
    left join public.attendance a on a.event_id = e.id
    left join public.people p on p.id = a.person_id
    group by g.month
  ) m;

  -- Attendance by category ------------------------------------------------------
  select coalesce(jsonb_agg(c order by c.meetings desc, c.category), '[]'::jsonb) into v_categories
  from (
    select e.category,
           count(distinct e.id)::integer as meetings,
           count(a.id) filter (where p.kind = 'member')::integer as member_attendance,
           count(a.id) filter (where p.kind = 'visitor')::integer as visitor_attendance
    from public.events e
    left join public.attendance a on a.event_id = e.id
    left join public.people p on p.id = a.person_id
    where extract(year from e.event_date) = p_year
      and e.status in ('published', 'completed') and e.attendance_enabled
      and (v_cat is null or e.category = v_cat)
    group by e.category
  ) c;

  -- The year before, for comparison ----------------------------------------------
  select jsonb_build_object(
    'year', p_year - 1,
    'meetings', count(distinct e.id),
    'attendance_records', count(a.id),
    'unique_people', count(distinct a.person_id)
  ) into v_prev
  from public.events e
  left join public.attendance a on a.event_id = e.id
  where extract(year from e.event_date) = p_year - 1
    and e.status in ('published', 'completed') and e.attendance_enabled
    and (v_cat is null or e.category = v_cat);

  return jsonb_build_object('ok', true, 'year', p_year, 'scope', v_scope, 'category', v_cat,
    'summary', v_summary, 'ranking', v_ranking, 'monthly', v_monthly,
    'categories', v_categories, 'previous', v_prev);
end;
$$;

-- Active members who have not been seen at any meeting for a while (or ever).
create or replace function public.admin_lapsed_members(p_days integer default 60)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  today date := (now() at time zone private.event_tz())::date;
  v_days integer := least(greatest(coalesce(p_days, 60), 1), 3650);
  v_rows jsonb;
begin
  perform private.require_admin();
  select coalesce(jsonb_agg(x order by x.last_attended nulls first, lower(x.full_name)), '[]'::jsonb) into v_rows
  from (
    select p.id as person_id, private.person_label(p) as label, p.full_name, p.phone,
           l.last_attended, (today - l.last_attended) as days_since
    from public.people p
    left join lateral (
      select max(e.event_date) as last_attended
      from public.attendance a join public.events e on e.id = a.event_id
      where a.person_id = p.id and e.status in ('published', 'completed')
    ) l on true
    where p.kind = 'member' and p.status = 'active'
      and (l.last_attended is null or l.last_attended < today - v_days)
  ) x;
  return jsonb_build_object('ok', true, 'days', v_days, 'rows', v_rows);
end;
$$;

-- Staff (administrators and managers) look people up to mark them present by hand, for
-- example a member who was missed at the door. Managers only see masked phone numbers.
create or replace function public.staff_search_people(p_event_id uuid, p_query text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  q text := left(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')), 60);
  digits text;
  v_full boolean;
  results jsonb;
begin
  perform private.require_staff();
  v_full := private.is_admin_user();
  if char_length(q) < 3 then
    return private.fail('query_too_short', 'Type at least 3 characters.');
  end if;
  digits := regexp_replace(regexp_replace(q, '[^0-9]', '', 'g'), '^0+', '');

  select coalesce(jsonb_agg(row_to_json(m)::jsonb order by m.full_name), '[]'::jsonb) into results
  from (
    select p.id as person_id, private.person_label(p) as label, p.kind, p.membership_type, p.full_name,
           case when v_full then p.phone else private.mask_phone(p.phone) end as phone,
           exists (select 1 from public.registrations r
                   where r.event_id = p_event_id and r.person_id = p.id and r.status = 'registered') as registered,
           (a.id is not null) as checked_in, a.checked_in_at
    from public.people p
    left join public.attendance a on a.event_id = p_event_id and a.person_id = p.id
    where p.status = 'active'
      and (
        lower(p.full_name) like '%' || lower(private.escape_like(q)) || '%' escape '\'
        or (char_length(digits) >= 4 and (p.phone like '%' || digits || '%' or p.alt_phone like '%' || digits || '%'))
      )
    order by p.full_name
    limit 15
  ) m;
  return jsonb_build_object('ok', true, 'results', results);
end;
$$;

-- ---------------------------------------------------------------------------
-- Bulk import of members (from a CSV the browser has already read into rows).
-- The same rules as adding a member by hand apply to every row: a phone number that is
-- already registered is never added again, similar names are held back for review, and
-- anything wrong is reported against its row. With p_commit = false nothing is saved: it is
-- the "check the file" preview. With p_commit = true the rows that passed are saved in one go.
-- ---------------------------------------------------------------------------
create or replace function private.import_membership_type(p text)
returns text
language sql
immutable
as $$
  select case regexp_replace(lower(btrim(coalesce(p, ''))), '[^a-z]+', ' ', 'g')
    when '' then null
    when 'incoming commitment class' then 'incoming_commitment'
    when 'incoming commitment' then 'incoming_commitment'
    when 'incoming' then 'incoming_commitment'
    when 'in commitment class' then 'in_commitment'
    when 'in commitment' then 'in_commitment'
    when 'commitment class' then 'in_commitment'
    when 'member' then 'member'
    when 'visitor' then 'visitor'
    else regexp_replace(lower(btrim(p)), '[^a-z]+', ' ', 'g')
  end
$$;

create or replace function public.admin_import_members(
  p_rows jsonb,
  p_commit boolean default false,
  p_create_deaconesses boolean default false,
  p_allow_similar boolean default false
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  r record;
  f record;
  v_results jsonb := '[]'::jsonb;
  v_seen_phones text[] := '{}';
  v_new_deaconesses text[] := '{}';
  v_status text;
  v_msg text;
  v_label text;
  v_line integer;
  v_phone_out text;
  v_gender text;
  v_type text;
  v_date date;
  v_date_text text;
  v_dea_name text;
  v_dea_id uuid;
  v_dea public.deaconesses;
  v_existing public.people;
  v_dupes jsonb;
  v_person public.people;
  n_new integer := 0;
  n_skipped integer := 0;
  n_error integer := 0;
begin
  perform private.require_admin();

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return private.fail('invalid_rows', 'The file could not be read.');
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return private.fail('empty', 'The file has no people in it.');
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    return private.fail('too_many_rows', 'Import at most 2000 people at a time. Split the file and import it in parts.');
  end if;

  for r in select value as v, ordinality as n from jsonb_array_elements(p_rows) with ordinality loop
    v_status := 'new';
    v_msg := null;
    v_label := null;
    v_dea_id := null;
    v_phone_out := r.v ->> 'phone';
    v_line := coalesce(nullif(r.v ->> 'line', '')::integer, r.n::integer + 1);

    begin
      -- Friendly spellings of gender and membership type
      v_gender := case lower(btrim(coalesce(r.v ->> 'gender', '')))
        when '' then null
        when 'f' then 'female' when 'female' then 'female' when 'woman' then 'female'
        when 'm' then 'male' when 'male' then 'male' when 'man' then 'male'
        else lower(btrim(r.v ->> 'gender')) end;
      v_type := private.import_membership_type(r.v ->> 'membership_type');

      select * into f from private.validate_person_fields(
        r.v ->> 'full_name', r.v ->> 'phone', r.v ->> 'alt_phone', r.v ->> 'email', v_gender,
        r.v ->> 'department', r.v ->> 'church', r.v ->> 'notes', r.v ->> 'residence', v_type);

      -- (a blank phone normalises to a bare "+", which is not worth showing)
      v_phone_out := case when f.v_phone = '+' then null else coalesce(f.v_phone, v_phone_out) end;
      v_date := null;
      v_date_text := nullif(btrim(coalesce(r.v ->> 'membership_date', '')), '');

      if f.v_error is not null then
        v_status := 'error';
        v_msg := f.v_error ->> 'message';
      elsif f.v_type = 'visitor' then
        v_status := 'error';
        v_msg := 'This import is for members. Use Incoming Commitment Class, In Commitment Class or Member, or leave the type blank.';
      elsif v_date_text is not null and v_date_text !~ '^\d{4}-\d{2}-\d{2}$' then
        v_status := 'error';
        v_msg := format('The membership date "%s" is not a date. Use year-month-day, for example 2024-03-17.', v_date_text);
      end if;

      if v_status = 'new' and v_date_text is not null then
        begin
          v_date := v_date_text::date;
        exception when others then
          v_status := 'error';
          v_msg := format('The membership date "%s" is not a real date.', v_date_text);
        end;
      end if;

      -- The deaconess is looked up by name in the list
      v_dea_name := private.clean_text(r.v ->> 'deaconess', 100);
      if v_status = 'new' and v_dea_name is not null then
        select * into v_dea from public.deaconesses where lower(btrim(name)) = lower(v_dea_name);
        if found then
          if not v_dea.active then
            v_status := 'error';
            v_msg := format('Deaconess "%s" is inactive, so she cannot be given new members.', v_dea.name);
          else
            v_dea_id := v_dea.id;
          end if;
        elsif p_create_deaconesses then
          if not (lower(v_dea_name) = any (select lower(x) from unnest(v_new_deaconesses) x)) then
            v_new_deaconesses := array_append(v_new_deaconesses, v_dea_name);
          end if;
        else
          v_status := 'error';
          v_msg := format('Deaconess "%s" is not in the list. Add her under Deaconesses first, or tick the option to add new deaconesses.', v_dea_name);
        end if;
      end if;

      -- Phone numbers are never registered twice
      if v_status = 'new' then
        if f.v_phone = any (v_seen_phones) then
          v_status := 'skipped';
          v_msg := 'The same phone number appears earlier in this file.';
        else
          select * into v_existing from public.people where phone = f.v_phone or alt_phone = f.v_phone;
          if found then
            v_status := 'skipped';
            v_msg := case when v_existing.kind = 'visitor'
              then format('%s (%s) is already on record as a visitor. Convert them on the Visitors page.', v_existing.full_name, private.person_label(v_existing))
              else format('%s (%s) is already registered with this phone number.', v_existing.full_name, private.person_label(v_existing)) end;
          end if;
        end if;
      end if;

      -- A similar name or the same email: held back unless the administrator says otherwise
      if v_status = 'new' and not coalesce(p_allow_similar, false) then
        v_dupes := private.possible_duplicates(f.v_name, f.v_phone, f.v_alt, f.v_email);
        if jsonb_array_length(v_dupes) > 0 then
          v_status := 'skipped';
          v_msg := format('Possible duplicate of %s (%s). Check them, or tick "import similar names anyway".',
                          v_dupes -> 0 ->> 'full_name', v_dupes -> 0 ->> 'label');
        end if;
      end if;

      -- Remember the numbers this file will add, so the same number twice is caught
      if v_status = 'new' then
        v_seen_phones := array_append(v_seen_phones, f.v_phone);
      end if;

      if v_status = 'new' and p_commit then
        if v_dea_name is not null and v_dea_id is null then
          select id into v_dea_id from public.deaconesses where lower(btrim(name)) = lower(v_dea_name);
          if v_dea_id is null then
            insert into public.deaconesses (name, created_by) values (v_dea_name, 'admin:' || auth.uid()::text)
            returning id into v_dea_id;
          end if;
        end if;
        insert into public.people
          (kind, membership_type, full_name, phone, alt_phone, email, gender, membership_date, department,
           residence, deaconess_id, church_name, notes, created_by)
        values
          ('member', coalesce(f.v_type, 'member'), f.v_name, f.v_phone, f.v_alt, f.v_email, f.v_gender,
           coalesce(v_date, (now() at time zone private.event_tz())::date),
           f.v_department, f.v_residence, v_dea_id, f.v_church, f.v_notes, 'admin:' || auth.uid()::text)
        returning * into v_person;
        v_label := private.person_label(v_person);
      end if;
    exception when others then
      v_status := 'error';
      v_msg := 'This row could not be saved: ' || sqlerrm;
    end;

    if v_status = 'new' then n_new := n_new + 1;
    elsif v_status = 'skipped' then n_skipped := n_skipped + 1;
    else n_error := n_error + 1;
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'row', v_line, 'name', private.clean_text(r.v ->> 'full_name', 100),
      'phone', v_phone_out, 'status', v_status, 'message', v_msg, 'label', v_label));
  end loop;

  if p_commit then
    perform private.audit('admin:' || auth.uid()::text, 'members_imported', null,
      jsonb_build_object('imported', n_new, 'skipped', n_skipped, 'errors', n_error));
  end if;

  return jsonb_build_object(
    'ok', true, 'committed', coalesce(p_commit, false),
    'counts', jsonb_build_object('total', jsonb_array_length(p_rows), 'new', n_new, 'skipped', n_skipped, 'errors', n_error),
    'new_deaconesses', to_jsonb(v_new_deaconesses),
    'rows', v_results);
end;
$$;
