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
  select exists (select 1 from public.admin_roles where user_id = auth.uid())
$$;

create or replace function private.require_admin()
returns void
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not exists (select 1 from public.admin_roles where user_id = auth.uid()) then
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
    when now() > (coalesce(e.end_date, e.event_date) + coalesce(e.end_time, time '23:59:59')) at time zone 'Africa/Nairobi' then 'ended'
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
where e.status = 'published';

-- ---------------------------------------------------------------------------
-- register_participant(): the ONLY way a participant is created.
-- The event row is locked FOR UPDATE, so concurrent registrations for one event
-- are processed one at a time and capacity can never be exceeded.
-- ---------------------------------------------------------------------------
-- The signature gained p_consent, so the old five-argument version must go.
drop function if exists public.register_participant(uuid, text, text, text, text);

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
  if now() > private.event_end_at(ev) then
    return private.fail('event_ended', 'This event has already taken place.');
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

  loop
    attempts := attempts + 1;
    v_ref := 'HOL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    v_token := private.new_token();

    begin
      insert into public.registrations
        (event_id, full_name, email, phone, church_name, registration_reference, qr_token_hash, consented_at)
      values
        (ev.id, v_name, v_email, v_phone, v_church, v_ref, private.hash_token(v_token), now())
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
create or replace function private.resolve_volunteer(p_token text)
returns table (access_id uuid, event_id uuid, label text, state text)
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
  access_id := null; event_id := null; label := null;

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

  select * into va from public.volunteer_access where token_hash = private.hash_token(p_token);

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
  if va.expires_at <= now() then
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

  if not private.rate_limit('vol:' || va.id::text, 'ops', 90, interval '1 minute') then
    state := 'rate_limited';
    return next;
    return;
  end if;

  update public.volunteer_access set last_used_at = now() where id = va.id;

  access_id := va.id;
  event_id := va.event_id;
  label := va.label;
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

  -- Check-in opens a week before the event (so volunteers can rehearse and test)
  -- and closes one day after it ends. Times are shown in Nairobi time.
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

  insert into public.attendance (registration_id, event_id, method, checked_in_by)
  values (r.id, r.event_id, p_method, p_actor)
  on conflict (registration_id) do nothing
  returning id into v_inserted;

  if v_inserted is not null then
    perform private.audit(p_actor, 'check_in', r.event_id,
      jsonb_build_object('registration_id', r.id, 'method', p_method));
    return jsonb_build_object('ok', true, 'result', 'checked_in', 'full_name', r.full_name,
                              'checked_in_at', now());
  end if;

  select checked_in_at into v_at from public.attendance where registration_id = r.id;
  return jsonb_build_object('ok', true, 'result', 'already_checked_in', 'full_name', r.full_name,
                            'checked_in_at', v_at);
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
    'event', jsonb_build_object(
      'name', ev.name, 'venue', ev.venue, 'event_date', ev.event_date,
      'start_time', ev.start_time, 'end_date', ev.end_date, 'end_time', ev.end_time
    ),
    'registered', (select count(*) from public.registrations
                   where event_id = ev.id and status = 'registered'),
    'checked_in', (select count(*) from public.attendance a
                   join public.registrations r on r.id = a.registration_id
                   where a.event_id = ev.id and r.status = 'registered')
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
create or replace function public.admin_create_volunteer_link(
  p_event_id uuid,
  p_label text,
  p_expires_at timestamptz
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
  insert into public.volunteer_access (event_id, token_hash, label, expires_at)
  values (p_event_id, private.hash_token(v_token), v_label, p_expires_at)
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

  result := public.admin_create_volunteer_link(old.event_id, old.label, p_expires_at);
  if (result ->> 'ok')::boolean then
    update public.volunteer_access set revoked_at = coalesce(revoked_at, now()) where id = p_access_id;
  end if;
  return result;
end;
$$;

create or replace function public.admin_set_attendance(p_registration_id uuid, p_present boolean)
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

  select * into r from public.registrations where id = p_registration_id and status = 'registered';
  if not found then
    return private.fail('not_found', 'Registration not found.');
  end if;

  if p_present then
    insert into public.attendance (registration_id, event_id, method, checked_in_by)
    values (r.id, r.event_id, 'admin', 'admin:' || auth.uid()::text)
    on conflict (registration_id) do nothing;
  else
    delete from public.attendance where registration_id = r.id;
  end if;

  perform private.audit('admin:' || auth.uid()::text,
    case when p_present then 'attendance_marked' else 'attendance_cleared' end,
    r.event_id, jsonb_build_object('registration_id', r.id));
  return jsonb_build_object('ok', true);
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
  perform private.require_admin();

  select * into ev from public.events where id = p_event_id;
  if not found then
    return private.fail('not_found', 'Event not found.');
  end if;
  ended := now() > private.event_end_at(ev);

  with base as (
    select
      r.id, r.full_name, r.email, r.phone, r.church_name, r.registration_reference,
      r.status, r.created_at, a.checked_in_at, a.method as check_in_method
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
      r.id, r.full_name, r.email, r.phone, r.church_name, r.registration_reference,
      r.status, r.created_at, a.checked_in_at, a.method as check_in_method
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
    'cancelled_registrations', t.cancelled
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
  perform private.require_admin();

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
  perform private.require_admin();

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
