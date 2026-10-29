// Database tests for Handmaidens of the Lord.
//
// Runs sql/schema.sql, sql/functions.sql and sql/policies.sql against an
// in-memory PostgreSQL (PGlite) with small stand-ins for Supabase's auth and
// storage schemas, then checks the security and business rules as the real
// "anon" and "authenticated" roles.
//
//   cd tests && npm install && npm test
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Print a short message instead of a minified stack trace if anything throws.
for (const evt of ['uncaughtException', 'unhandledRejection']) {
  process.on(evt, (e) => {
    console.error('ERROR:', (e && e.message) || e)
    process.exit(1)
  })
}

const here = path.dirname(fileURLToPath(import.meta.url))
const sql = (f) => readFileSync(path.join(here, '..', 'sql', f), 'utf8')

const db = new PGlite()

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`)
  }
}

// Run a callback as a given database role (and optional signed-in user / client IP).
async function as(role, fn, { uid = '', ip = '10.0.0.1' } = {}) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid])
  await db.query(`select set_config('request.headers', $1, false)`, [
    JSON.stringify({ 'x-forwarded-for': ip }),
  ])
  if (role) await db.exec(`set role ${role}`)
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}

async function rpc(fn, args) {
  const keys = Object.keys(args)
  const placeholders = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
  const r = await db.query(`select public.${fn}(${placeholders}) as r`, keys.map((k) => args[k]))
  return r.rows[0].r
}

async function denied(fn) {
  try {
    await fn()
    return false
  } catch (e) {
    return /permission denied|not_authorized|violates row-level security/i.test(e.message)
  }
}

async function errorMessage(fn) {
  try {
    await fn()
    return null
  } catch (e) {
    return e.message
  }
}

// ---------------------------------------------------------------------------
// Supabase stand-ins
// ---------------------------------------------------------------------------
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(),
    bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema auth, storage to anon, authenticated;
  grant select on storage.objects to anon;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`)

console.log('Applying sql/schema.sql, sql/functions.sql, sql/policies.sql ...')
await db.exec(sql('schema.sql'))
await db.exec(sql('functions.sql'))
await db.exec(sql('policies.sql'))
// Applying twice must be harmless (idempotent scripts).
await db.exec(sql('schema.sql'))
await db.exec(sql('functions.sql'))
await db.exec(sql('policies.sql'))
console.log('Scripts applied (twice).\n')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const adminId = '11111111-1111-1111-1111-111111111111'
const memberId = '22222222-2222-2222-2222-222222222222'
await db.exec(`
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'), ('${memberId}', 'member@example.com');
  insert into public.admin_roles (user_id) values ('${adminId}');
`)

const tomorrow = (
  await db.query(`select ((now() at time zone 'Africa/Nairobi')::date + 1)::text as d`)
).rows[0].d

async function makeEvent(name, capacity, extra = {}) {
  const r = await db.query(
    `insert into public.events (name, venue, event_date, start_time, end_time, capacity, status,
        poster_path, registration_opens_at, registration_closes_at)
     values ($1, 'Main Hall', $2, '00:00', '23:00', $3, $4, $5, $6, $7) returning id`,
    [
      name,
      extra.date || tomorrow,
      capacity,
      extra.status || 'published',
      extra.poster || null,
      extra.opens || null,
      extra.closes || null,
    ]
  )
  return r.rows[0].id
}

const reg = (eventId, n, over = {}, opts) =>
  as(
    'anon',
    () =>
      rpc('register_participant', {
        p_event_id: eventId,
        p_full_name: over.name ?? `Grace Person ${n}`,
        p_email: over.email ?? `grace${n}@example.com`,
        p_phone: over.phone ?? `0712 000 ${String(100 + n)}`,
        p_church_name: over.church ?? 'Redeemed Gospel Church',
        p_consent: over.consent ?? true,
      }),
    opts
  )

// ===========================================================================
console.log('1. Public access is limited to published events')
// ===========================================================================
const evA = await makeEvent('Annual Women Conference', 3, { poster: 'posters/a.png' })
const evDraft = await makeEvent('Secret Draft Event', 10, { status: 'draft', poster: 'posters/draft.png' })
const evCancelled = await makeEvent('Cancelled Event', 10, { status: 'cancelled' })

const listing = await as('anon', () => db.query('select id, name, spots_remaining, registration_state from public.public_events'))
check('anonymous sees the published event', listing.rows.some((r) => r.id === evA))
check('anonymous does NOT see draft or cancelled events',
  !listing.rows.some((r) => r.id === evDraft || r.id === evCancelled))
check('spots remaining shown (3 of 3)', listing.rows.find((r) => r.id === evA)?.spots_remaining === 3)

for (const table of ['events', 'registrations', 'attendance', 'volunteer_access', 'admin_roles', 'audit_log']) {
  check(`anonymous cannot read ${table}`, await denied(() => as('anon', () => db.query(`select * from public.${table}`))))
}
check('anonymous cannot create events',
  await denied(() => as('anon', () => db.query(`insert into public.events (name, venue, event_date, start_time, capacity) values ('x','y', current_date, '10:00', 5)`))))
check('anonymous cannot call admin functions',
  await denied(() => as('anon', () => rpc('admin_dashboard_stats', {}))))
check('anonymous cannot read private rate-limit table',
  await denied(() => as('anon', () => db.query('select * from private.rate_limits'))))
check('anonymous cannot call private helper functions',
  await denied(() => as('anon', () => db.query(`select private.new_token()`))))

// ===========================================================================
console.log('\n2. Registration: validation, duplicates, capacity')
// ===========================================================================
const r1 = await reg(evA, 1, {}, { ip: '10.1.0.1' })
check('valid registration succeeds', r1.ok === true, JSON.stringify(r1))
check('reference has HOL- prefix', /^HOL-[0-9A-F]{8}$/.test(r1.registration_reference || ''))
check('QR token is long and opaque', (r1.qr_token || '').length === 64 && /^[0-9a-f]+$/.test(r1.qr_token))
check('QR token does not contain personal data',
  !/grace|example|0712|redeemed/i.test(r1.qr_token))

const stored = await db.query(`select phone, email, qr_token_hash from public.registrations where registration_reference = $1`, [r1.registration_reference])
check('phone normalised to +254 format', stored.rows[0].phone === '+254712000101', stored.rows[0].phone)
check('only a hash of the token is stored', stored.rows[0].qr_token_hash !== r1.qr_token && stored.rows[0].qr_token_hash.length === 64)

const dupe = await reg(evA, 1, { email: 'GRACE1@Example.com' }, { ip: '10.1.0.2' })
check('duplicate e-mail (any case) rejected', dupe.error === 'already_registered', JSON.stringify(dupe))

// The same person cannot register again with a different e-mail but the same phone,
// however the number is written.
let phoneN = 0
for (const spelling of ['0712000101', '+254712000101', '254712000101', '712000101', '+254 0712 000 101', '0712-000-101', '00254712000101']) {
  phoneN += 1
  const d = await reg(evA, 50 + phoneN, { phone: spelling, email: `other${phoneN}@example.com` }, { ip: `10.1.1.${phoneN}` })
  check(`same phone as "${spelling}" rejected`, d.error === 'phone_already_registered', JSON.stringify(d))
}
const afterDupes = await db.query(`select count(*)::int as n from public.registrations where event_id = $1`, [evA])
check('rejected duplicates created no registration', afterDupes.rows[0].n === 1, String(afterDupes.rows[0].n))
const phoneNorm = (await db.query(`select private.normalize_phone('0702499324') a, private.normalize_phone('+254702499324') b, private.normalize_phone('254 702 499 324') c, private.normalize_phone('+2540702499324') d`)).rows[0]
check('0702499324 and +254702499324 are the same number', phoneNorm.a === '+254702499324' && phoneNorm.a === phoneNorm.b && phoneNorm.b === phoneNorm.c && phoneNorm.c === phoneNorm.d, JSON.stringify(phoneNorm))

const noConsent = await reg(evA, 9, { consent: false }, { ip: '10.1.0.3' })
check('registration without consent rejected', noConsent.error === 'consent_required', JSON.stringify(noConsent))
check('consent time is recorded',
  (await db.query(`select consented_at is not null as ok from public.registrations where registration_reference = $1`, [r1.registration_reference])).rows[0].ok)

// The email address is optional.
const evNoEmail = await makeEvent('No Email Event', 10)
const noEmail1 = await reg(evNoEmail, 60, { email: '', phone: '0713 000 601' }, { ip: '10.1.2.1' })
check('registration without an email address is accepted', noEmail1.ok === true, JSON.stringify(noEmail1))
check('a missing email is stored as null',
  (await db.query(`select email is null as n from public.registrations where registration_reference = $1`, [noEmail1.registration_reference])).rows[0].n)
const noEmail2 = await reg(evNoEmail, 61, { email: '   ', phone: '0713 000 602' }, { ip: '10.1.2.2' })
check('two registrations without email do not clash', noEmail2.ok === true, JSON.stringify(noEmail2))
const noEmailDupPhone = await reg(evNoEmail, 62, { email: '', phone: '0713000601' }, { ip: '10.1.2.3' })
check('same phone is still rejected when no email is given', noEmailDupPhone.error === 'phone_already_registered', JSON.stringify(noEmailDupPhone))

check('invalid e-mail rejected', (await reg(evA, 9, { email: 'not-an-email' }, { ip: '10.1.0.3' })).error === 'invalid_email')
check('invalid phone rejected', (await reg(evA, 9, { phone: '12' }, { ip: '10.1.0.3' })).error === 'invalid_phone')
check('missing name rejected', (await reg(evA, 9, { name: ' ' }, { ip: '10.1.0.3' })).error === 'invalid_name')
check('missing church rejected', (await reg(evA, 9, { church: '' }, { ip: '10.1.0.3' })).error === 'invalid_church')

const r2 = await reg(evA, 2, {}, { ip: '10.1.0.4' })
const r3 = await reg(evA, 3, {}, { ip: '10.1.0.5' })
check('registrations 2 and 3 fill the event', r2.ok && r3.ok)
const full = await reg(evA, 4, {}, { ip: '10.1.0.6' })
check('registration beyond capacity rejected', full.error === 'event_full', JSON.stringify(full))
const cnt = await db.query(`select count(*)::int as n from public.registrations where event_id = $1`, [evA])
check('registered count never exceeds capacity', cnt.rows[0].n === 3)

check('draft event cannot be registered for', (await reg(evDraft, 1, {}, { ip: '10.1.0.7' })).error === 'event_unavailable')
check('cancelled event cannot be registered for', (await reg(evCancelled, 1, {}, { ip: '10.1.0.7' })).error === 'event_unavailable')

const evFuture = await makeEvent('Opens Later', 5, { opens: new Date(Date.now() + 86400000 * 2).toISOString() })
check('registration before opening time rejected', (await reg(evFuture, 1, {}, { ip: '10.1.0.8' })).error === 'registration_not_open')
const evClosed = await makeEvent('Closed Window', 5, { opens: new Date(Date.now() - 86400000 * 3).toISOString(), closes: new Date(Date.now() - 86400000).toISOString() })
check('registration after closing time rejected', (await reg(evClosed, 1, {}, { ip: '10.1.0.9' })).error === 'registration_closed')
const evPast = await makeEvent('Already Happened', 5, { date: '2020-01-01' })
check('registration for a past event rejected', (await reg(evPast, 1, {}, { ip: '10.1.0.9' })).error === 'event_ended')

let limited = null
for (let i = 0; i < 17; i++) limited = await reg(evFuture, 100 + i, {}, { ip: '10.9.9.9' })
check('registration attempts are rate limited per client', limited.error === 'rate_limited', JSON.stringify(limited))

// Cancelling a registration frees the e-mail and the seat.
const regRow = (await db.query(`select id from public.registrations where registration_reference = $1`, [r3.registration_reference])).rows[0]
check('admin cancel is refused for a non-admin', await denied(() => as('authenticated', () => rpc('admin_cancel_registration', { p_registration_id: regRow.id }), { uid: memberId })))
const cancelled = await as('authenticated', () => rpc('admin_cancel_registration', { p_registration_id: regRow.id }), { uid: adminId })
check('admin can cancel a registration', cancelled.ok === true, JSON.stringify(cancelled))
const again = await reg(evA, 3, {}, { ip: '10.1.0.10' })
check('seat is freed after cancellation', again.ok === true, JSON.stringify(again))

// ===========================================================================
console.log('\n3. Confirmation re-open needs the secret token')
// ===========================================================================
const good = await as('anon', () => rpc('get_registration_confirmation', { p_reference: r1.registration_reference, p_token: r1.qr_token }), { ip: '10.2.0.1' })
check('correct reference + token returns the confirmation', good.ok === true && good.full_name === 'Grace Person 1')
const bad = await as('anon', () => rpc('get_registration_confirmation', { p_reference: r1.registration_reference, p_token: 'a'.repeat(64) }), { ip: '10.2.0.1' })
check('wrong token is refused', bad.ok === false && bad.error === 'not_found')
check('confirmation exposes no e-mail or phone', !('email' in good) && !('phone' in good))

// ===========================================================================
console.log('\n4. Administrators and role safety')
// ===========================================================================
check('non-admin signed-in user cannot read events', (await as('authenticated', () => db.query('select * from public.events'), { uid: memberId })).rows.length === 0)
check('non-admin signed-in user cannot read registrations', (await as('authenticated', () => db.query('select * from public.registrations'), { uid: memberId })).rows.length === 0)
check('non-admin cannot create events',
  await denied(() => as('authenticated', () => db.query(`insert into public.events (name, venue, event_date, start_time, capacity) values ('Hack','y', current_date, '10:00', 5)`), { uid: memberId })))
check('user cannot make themselves an admin',
  await denied(() => as('authenticated', () => db.query(`insert into public.admin_roles (user_id) values ('${memberId}')`), { uid: memberId })))
check('admin cannot rewrite roles either',
  await denied(() => as('authenticated', () => db.query(`insert into public.admin_roles (user_id) values ('${memberId}')`), { uid: adminId })))
check('non-admin gets not_authorized from admin functions',
  await denied(() => as('authenticated', () => rpc('admin_dashboard_stats', {}), { uid: memberId })))

const adminEvents = await as('authenticated', () => db.query('select id from public.events'), { uid: adminId })
check('admin can read all events (incl. draft)', adminEvents.rows.length >= 3)
const adminRegs = await as('authenticated', () => db.query('select id from public.registrations'), { uid: adminId })
check('admin can read registrations', adminRegs.rows.length >= 3)

check('admin can update an event',
  (await as('authenticated', () => db.query(`update public.events set description = 'Updated' where id = $1 returning id`, [evA]), { uid: adminId })).rows.length === 1)
check('admin cannot write attendance directly',
  await denied(() => as('authenticated', () => db.query(`insert into public.attendance (registration_id, event_id, method, checked_in_by) values ('${regRow.id}', '${evA}', 'admin', 'x')`), { uid: adminId })))
check('admin cannot read volunteer token hashes',
  await denied(() => as('authenticated', () => db.query('select token_hash from public.volunteer_access'), { uid: adminId })))
check('admin cannot delete events', await denied(() => as('authenticated', () => db.query(`delete from public.events where id = $1`, [evA]), { uid: adminId })))

const lowered = await errorMessage(() => as('authenticated', () => db.query(`update public.events set capacity = 1 where id = $1`, [evA]), { uid: adminId }))
check('capacity cannot be lowered below active registrations', /cannot be lower/i.test(lowered || ''), lowered)

// ===========================================================================
console.log('\n5. Volunteer check-in (no login)')
// ===========================================================================
const link = await as('authenticated', () => rpc('admin_create_volunteer_link', { p_event_id: evA, p_label: 'Main door', p_expires_at: new Date(Date.now() + 86400000 * 3).toISOString() }), { uid: adminId })
check('admin creates a volunteer link', link.ok && link.token.length === 64, JSON.stringify(link))
check('non-admin cannot create volunteer links',
  await denied(() => as('authenticated', () => rpc('admin_create_volunteer_link', { p_event_id: evA, p_label: 'x', p_expires_at: new Date(Date.now() + 3600000).toISOString() }), { uid: memberId })))
const hashRow = (await db.query(`select token_hash from public.volunteer_access where id = $1`, [link.id])).rows[0]
check('only the link token hash is stored', hashRow.token_hash !== link.token)

const vt = link.token
const volIp = { ip: '10.3.0.1' }
const info = await as('anon', () => rpc('volunteer_event', { p_token: vt }), volIp)
check('volunteer page loads the assigned event', info.ok && info.event.name === 'Annual Women Conference', JSON.stringify(info))
check('volunteer event info has no participant data', !JSON.stringify(info).includes('example.com'))

const s1 = await as('anon', () => rpc('volunteer_search', { p_token: vt, p_query: 'grace person 1' }), volIp)
check('search by name finds the participant', s1.ok && s1.results.length === 1, JSON.stringify(s1))
check('search results hide e-mail, church and full phone',
  s1.results[0] && !('email' in s1.results[0]) && !('church_name' in s1.results[0]) && !JSON.stringify(s1).includes('712000101'))
check('search shows a masked phone hint', s1.results[0]?.phone_hint?.endsWith('101'))

const s2 = await as('anon', () => rpc('volunteer_search', { p_token: vt, p_query: '0712 000 101' }), volIp)
check('search by local-format phone number works', s2.ok && s2.results.length === 1, JSON.stringify(s2))
const s3 = await as('anon', () => rpc('volunteer_search', { p_token: vt, p_query: '+254712000101' }), volIp)
check('search by international phone number works', s3.ok && s3.results.length === 1)
check('search with fewer than 3 characters refused', (await as('anon', () => rpc('volunteer_search', { p_token: vt, p_query: 'gr' }), volIp)).error === 'query_too_short')
const s4 = await as('anon', () => rpc('volunteer_search', { p_token: vt, p_query: '%' }), volIp)
check('wildcard characters do not match everyone', s4.ok === false || s4.results.length === 0, JSON.stringify(s4))

const personId = s1.results[0].registration_id
const ci1 = await as('anon', () => rpc('volunteer_check_in', { p_token: vt, p_registration_id: personId }), volIp)
check('check-in by search succeeds', ci1.ok && ci1.result === 'checked_in', JSON.stringify(ci1))
const ci2 = await as('anon', () => rpc('volunteer_check_in', { p_token: vt, p_registration_id: personId }), volIp)
check('second check-in reports already checked in', ci2.ok && ci2.result === 'already_checked_in')
const attCount = await db.query(`select count(*)::int as n from public.attendance where registration_id = $1`, [personId])
check('only one attendance record exists', attCount.rows[0].n === 1)

const q2 = await as('anon', () => rpc('volunteer_check_in_qr', { p_token: vt, p_code: r2.qr_token }), volIp)
check('QR check-in with a valid participant token succeeds', q2.ok && q2.result === 'checked_in' && q2.full_name === 'Grace Person 2', JSON.stringify(q2))
const q2b = await as('anon', () => rpc('volunteer_check_in_qr', { p_token: vt, p_code: r2.qr_token }), volIp)
check('re-scanning the same QR code is a harmless duplicate', q2b.ok && q2b.result === 'already_checked_in')
const qBad = await as('anon', () => rpc('volunteer_check_in_qr', { p_token: vt, p_code: 'f'.repeat(64) }), volIp)
check('unknown QR token rejected', qBad.ok === false && qBad.error === 'invalid_code')
const qRef = await as('anon', () => rpc('volunteer_check_in_qr', { p_token: vt, p_code: again.registration_reference.toLowerCase() }), volIp)
check('manual entry of the reference code works', qRef.ok && qRef.result === 'checked_in', JSON.stringify(qRef))

const audit = await db.query(`select checked_in_by, method from public.attendance where registration_id = $1`, [personId])
check('attendance records the volunteer link and method', audit.rows[0].checked_in_by === `volunteer:${link.id}` && audit.rows[0].method === 'search')

// Event isolation
const evB = await makeEvent('Prayer Night', 10)
const bReg = await reg(evB, 50, { email: 'other@example.com' }, { ip: '10.4.0.1' })
const crossQr = await as('anon', () => rpc('volunteer_check_in_qr', { p_token: vt, p_code: bReg.qr_token }), volIp)
check("event A's link cannot check in event B's QR", crossQr.ok === false && crossQr.error === 'invalid_code')
check('rejected code message names the event being checked',
  /Annual Women Conference/.test(crossQr.message || ''), crossQr.message)
const bId = (await db.query(`select id from public.registrations where registration_reference = $1`, [bReg.registration_reference])).rows[0].id
const crossId = await as('anon', () => rpc('volunteer_check_in', { p_token: vt, p_registration_id: bId }), volIp)
check("event A's link cannot check in event B's registration id", crossId.ok === false && crossId.error === 'not_found')
const crossSearch = await as('anon', () => rpc('volunteer_search', { p_token: vt, p_query: 'Grace Person 50' }), volIp)
check("event A's link cannot search event B's participants", crossSearch.ok && crossSearch.results.length === 0)

// Invalid / expired / revoked tokens
const wrong = await as('anon', () => rpc('volunteer_event', { p_token: 'z'.repeat(64) }), { ip: '10.5.0.1' })
check('unknown volunteer token rejected', wrong.ok === false && wrong.error === 'invalid_access')

const shortLink = await as('authenticated', () => rpc('admin_create_volunteer_link', { p_event_id: evA, p_label: 'Short', p_expires_at: new Date(Date.now() + 3600000).toISOString() }), { uid: adminId })
await db.query(`update public.volunteer_access set expires_at = now() - interval '1 minute' where id = $1`, [shortLink.id])
const expired = await as('anon', () => rpc('volunteer_event', { p_token: shortLink.token }), { ip: '10.5.0.2' })
check('expired volunteer link rejected', expired.error === 'expired', JSON.stringify(expired))

const revLink = await as('authenticated', () => rpc('admin_create_volunteer_link', { p_event_id: evA, p_label: 'Lost phone', p_expires_at: new Date(Date.now() + 86400000).toISOString() }), { uid: adminId })
check('revoked-to-be link works first', (await as('anon', () => rpc('volunteer_event', { p_token: revLink.token }), { ip: '10.5.0.3' })).ok === true)
await as('authenticated', () => rpc('admin_revoke_volunteer_link', { p_access_id: revLink.id }), { uid: adminId })
const revoked = await as('anon', () => rpc('volunteer_event', { p_token: revLink.token }), { ip: '10.5.0.3' })
check('revoked volunteer link rejected', revoked.error === 'revoked', JSON.stringify(revoked))
const search2 = await as('anon', () => rpc('volunteer_search', { p_token: revLink.token, p_query: 'grace' }), { ip: '10.5.0.3' })
check('revoked link cannot search either', search2.ok === false)

const regen = await as('authenticated', () => rpc('admin_regenerate_volunteer_link', { p_access_id: link.id, p_expires_at: new Date(Date.now() + 86400000).toISOString() }), { uid: adminId })
check('regenerating issues a new working token', regen.ok && (await as('anon', () => rpc('volunteer_event', { p_token: regen.token }), { ip: '10.5.0.4' })).ok === true)
check('regenerating revokes the old token', (await as('anon', () => rpc('volunteer_event', { p_token: vt }), { ip: '10.5.0.4' })).error === 'revoked')

// Token guessing gets locked out
let lockout = null
for (let i = 0; i < 25; i++) {
  lockout = await as('anon', () => rpc('volunteer_event', { p_token: `${i}`.padStart(40, 'g') }), { ip: '10.6.0.1' })
}
check('repeated bad tokens are rate limited', lockout.error === 'rate_limited', JSON.stringify(lockout))

// Check-in window
const evFar = await makeEvent('Far Future', 5, { date: '2099-01-01' })
const farLink = await as('authenticated', () => rpc('admin_create_volunteer_link', { p_event_id: evFar, p_label: 'x', p_expires_at: new Date(Date.now() + 86400000).toISOString() }), { uid: adminId })
await db.query(`update public.events set registration_opens_at = null where id = $1`, [evFar])
const farReg = await reg(evFar, 70, {}, { ip: '10.7.0.1' })
const farId = (await db.query(`select id from public.registrations where registration_reference = $1`, [farReg.registration_reference])).rows[0].id
const early = await as('anon', () => rpc('volunteer_check_in', { p_token: farLink.token, p_registration_id: farId }), { ip: '10.7.0.2' })
check('check-in is refused long before the event', early.error === 'outside_window', JSON.stringify(early))
check('the refusal names the event and the open dates',
  /Far Future/.test(early.message) && /2098/.test(early.message) && /2099/.test(early.message) && /Nairobi/.test(early.message),
  early.message)

// A few days ahead (someone rehearsing before the big day) is allowed.
const daysAhead = (n) => new Date(Date.now() + n * 86400000 + 3 * 3600000).toISOString().slice(0, 10)
const evSoon = await makeEvent('Rehearsal Event', 5, { date: daysAhead(4) })
const soonLink = await as('authenticated', () => rpc('admin_create_volunteer_link', { p_event_id: evSoon, p_label: 'x', p_expires_at: new Date(Date.now() + 86400000).toISOString() }), { uid: adminId })
const soonReg = await reg(evSoon, 80, {}, { ip: '10.7.0.3' })
const soonCi = await as('anon', () => rpc('volunteer_check_in_qr', { p_token: soonLink.token, p_code: soonReg.qr_token }), { ip: '10.7.0.4' })
check('check-in works for an event four days away', soonCi.ok && soonCi.result === 'checked_in', JSON.stringify(soonCi))

// Today's evening event (for example 8 pm) is open all day.
const evTonight = await makeEvent('Tonight Event', 5, { date: new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10) })
await db.query(`update public.events set start_time = '20:00', end_time = null where id = $1`, [evTonight])
const tonightLink = await as('authenticated', () => rpc('admin_create_volunteer_link', { p_event_id: evTonight, p_label: 'x', p_expires_at: new Date(Date.now() + 86400000).toISOString() }), { uid: adminId })
const tonightReg = await reg(evTonight, 81, {}, { ip: '10.7.0.5' })
const tonightCi = await as('anon', () => rpc('volunteer_check_in_qr', { p_token: tonightLink.token, p_code: tonightReg.qr_token }), { ip: '10.7.0.6' })
check('check-in works for an 8 pm event on the day', tonightReg.ok && tonightCi.ok && tonightCi.result === 'checked_in', JSON.stringify([tonightReg, tonightCi]))

// An overnight event (a kesha) ends on a later day than it starts.
const evKesha = await makeEvent('Kesha Night', 5, { date: daysAhead(-3) })
await db.query(`update public.events set start_time = '20:00', end_date = $2, end_time = '05:00' where id = $1`, [evKesha, daysAhead(1)])
const keshaView = (await db.query(`select registration_state, end_date::text from public.public_events where id = $1`, [evKesha])).rows[0]
check('event ending on a later day is not "ended" while it is running', keshaView.registration_state === 'open', JSON.stringify(keshaView))
const keshaLink = await as('authenticated', () => rpc('admin_create_volunteer_link', { p_event_id: evKesha, p_label: 'x', p_expires_at: new Date(Date.now() + 86400000).toISOString() }), { uid: adminId })
const keshaReg = await reg(evKesha, 82, {}, { ip: '10.7.0.7' })
const keshaCi = await as('anon', () => rpc('volunteer_check_in_qr', { p_token: keshaLink.token, p_code: keshaReg.qr_token }), { ip: '10.7.0.8' })
check('check-in works for an overnight event until its end date', keshaReg.ok && keshaCi.ok && keshaCi.result === 'checked_in', JSON.stringify([keshaReg, keshaCi]))
const badEnd = async (sqlText) => { try { await db.query(sqlText); return false } catch { return true } }
check('end date before the start date is rejected',
  await badEnd(`update public.events set end_date = event_date - 1 where id = '${evKesha}'`))
check('same-day end time before the start is rejected',
  await badEnd(`update public.events set end_date = null, start_time = '20:00', end_time = '05:00' where id = '${evKesha}'`))
check('later end date with an earlier clock time is accepted',
  !(await badEnd(`update public.events set end_date = event_date + 1, start_time = '20:00', end_time = '05:00' where id = '${evKesha}'`)))

// ===========================================================================
console.log('\n6. Admin attendance and reports')
// ===========================================================================
const cancelRegId = regRow.id
check('cancelled registration cannot be checked in',
  (await as('anon', () => rpc('volunteer_check_in', { p_token: regen.token, p_registration_id: cancelRegId }), { ip: '10.8.0.1' })).error === 'not_found')

const rep = await as('authenticated', () => rpc('admin_event_report', { p_event_id: evA }), { uid: adminId })
check('report: valid registrations excludes cancelled (3)', rep.report.registrations === 3, JSON.stringify(rep.report))
check('report: attendees counted (3)', rep.report.attendees === 3)
check('report: attendance percentage 100', Number(rep.report.attendance_percentage) === 100)
check('report: absentees are not claimed before the event ends', rep.report.absentees === null && rep.report.completed === false)
check('report: remaining capacity', rep.report.remaining_capacity === 0)
check('report has a church breakdown', rep.churches.length === 1 && rep.churches[0].registered === 3)

const unmark = await as('authenticated', () => rpc('admin_set_attendance', { p_registration_id: personId, p_present: false }), { uid: adminId })
check('admin can clear attendance', unmark.ok === true)
const mark = await as('authenticated', () => rpc('admin_set_attendance', { p_registration_id: personId, p_present: true }), { uid: adminId })
check('admin can mark a participant present', mark.ok === true)

const evZero = await makeEvent('Empty Event', 10)
const zero = await as('authenticated', () => rpc('admin_event_report', { p_event_id: evZero }), { uid: adminId })
check('zero registrations gives 0% safely', Number(zero.report.attendance_percentage) === 0 && zero.report.registrations === 0)

// A finished event: absentees become definite.
const evDone = await makeEvent('Past Convention', 10, { date: '2020-06-01' })
await db.exec(`
  insert into public.registrations (event_id, full_name, email, phone, church_name, registration_reference, qr_token_hash) values
   ('${evDone}', 'Mary One',   'm1@example.com', '+254700000001', 'Grace Chapel', 'HOL-DONE0001', 'h1'),
   ('${evDone}', 'Mary Two',   'm2@example.com', '+254700000002', 'Grace Chapel', 'HOL-DONE0002', 'h2'),
   ('${evDone}', 'Mary Three', 'm3@example.com', '+254700000003', 'Hope Church',  'HOL-DONE0003', 'h3'),
   ('${evDone}', 'Mary Four',  'm4@example.com', '+254700000004', 'Hope Church',  'HOL-DONE0004', 'h4');
  insert into public.attendance (registration_id, event_id, method, checked_in_by)
   select id, event_id, 'admin', 'admin:test' from public.registrations
   where registration_reference in ('HOL-DONE0001', 'HOL-DONE0003');
  update public.registrations set status = 'cancelled' where registration_reference = 'HOL-DONE0004';
`)
const done = await as('authenticated', () => rpc('admin_event_report', { p_event_id: evDone }), { uid: adminId })
check('finished event: 3 valid registrations (cancelled excluded)', done.report.registrations === 3, JSON.stringify(done.report))
check('finished event: 2 attended, 1 absent', done.report.attendees === 2 && done.report.absentees === 1)
check('finished event: attendance 66.7%', Number(done.report.attendance_percentage) === 66.7)
check('finished event: church breakdown (Grace 2/1, Hope 1/1)',
  done.churches.find((c) => c.church_name === 'Grace Chapel')?.attended === 1 &&
  done.churches.find((c) => c.church_name === 'Hope Church')?.attended === 1)

const list = await as('authenticated', () => rpc('admin_list_registrations', { p_event_id: evDone, p_filter: 'absent' }), { uid: adminId })
check('absent filter lists only no-shows of a finished event', list.total === 1 && list.rows[0].full_name === 'Mary Two', JSON.stringify(list))
const listLive = await as('authenticated', () => rpc('admin_list_registrations', { p_event_id: evA, p_filter: 'absent' }), { uid: adminId })
check('absent filter is empty while the event is still upcoming', listLive.total === 0)
const searchAdmin = await as('authenticated', () => rpc('admin_list_registrations', { p_event_id: evDone, p_search: '0700000003' }), { uid: adminId })
check('admin phone search matches', searchAdmin.total === 1 && searchAdmin.rows[0].full_name === 'Mary Three', JSON.stringify(searchAdmin))
const paged = await as('authenticated', () => rpc('admin_list_registrations', { p_event_id: evDone, p_sort: 'name_asc', p_limit: 2, p_offset: 0 }), { uid: adminId })
check('pagination returns total and a page', paged.total === 3 && paged.rows.length === 2 && paged.rows[0].full_name === 'Mary One')
check('non-admin cannot list registrations',
  await denied(() => as('authenticated', () => rpc('admin_list_registrations', { p_event_id: evDone }), { uid: memberId })))

const overview = await as('authenticated', () => rpc('admin_reports_overview', {}), { uid: adminId })
check('overview lists every event', overview.events.length >= 8)
const stats = await as('authenticated', () => rpc('admin_dashboard_stats', {}), { uid: adminId })
check('dashboard stats are computed from real data', stats.total_events >= 8 && stats.total_registrations >= 4 && stats.total_absentees >= 0, JSON.stringify(stats))

// ===========================================================================
console.log('\n7. Poster storage visibility')
// ===========================================================================
await db.query(`insert into storage.objects (bucket_id, name) values
  ('event-posters', 'posters/a.png'), ('event-posters', 'posters/draft.png'), ('event-posters', 'posters/orphan.png')`)
const pub = await as('anon', () => db.query(`select name from storage.objects order by name`))
check('anonymous can read the published event poster', pub.rows.some((r) => r.name === 'posters/a.png'))
check('anonymous cannot read a draft event poster', !pub.rows.some((r) => r.name === 'posters/draft.png'))
check('anonymous cannot read unrelated files', !pub.rows.some((r) => r.name === 'posters/orphan.png'))
const adm = await as('authenticated', () => db.query(`select name from storage.objects`), { uid: adminId })
check('admin can read every poster', adm.rows.length === 3)
check('non-admin cannot upload posters',
  await denied(() => as('authenticated', () => db.query(`insert into storage.objects (bucket_id, name) values ('event-posters', 'posters/x.png')`), { uid: memberId })))
check('admin can upload a poster',
  (await as('authenticated', () => db.query(`insert into storage.objects (bucket_id, name) values ('event-posters', 'posters/new.png') returning name`), { uid: adminId })).rows.length === 1)
check('admin cannot write outside the posters bucket',
  await denied(() => as('authenticated', () => db.query(`insert into storage.objects (bucket_id, name) values ('private-files', 'x.png')`), { uid: adminId })))
const bucket = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'event-posters'`)).rows[0]
check('poster bucket is private, 2 MB limit, images only',
  bucket.public === false && Number(bucket.file_size_limit) === 2097152 && bucket.allowed_mime_types.length === 3)

// ===========================================================================
console.log('\n8. Members, visitors, event links, ushers and reports')
{ // SECTION8-BLOCK: its own scope, so names never clash with the sections above
// ===========================================================================
const managerId = '33333333-3333-3333-3333-333333333333'
await db.exec(`
  insert into auth.users (id, email) values ('${managerId}', 'manager@example.com');
  insert into public.admin_roles (user_id, role) values ('${managerId}', 'manager');
`)
const A = (fn, args, ip) => as('authenticated', () => rpc(fn, args), { uid: adminId, ip })
const M = (fn, args) => as('authenticated', () => rpc(fn, args), { uid: managerId })
const U = (fn, args, ip = '10.8.8.8') => as('anon', () => rpc(fn, args), { ip })
const newEvent = async (name, extra = {}) =>
  (await db.query(
    `insert into public.events (name, venue, event_date, start_time, end_time, capacity, status, visibility,
        category, attendance_enabled, registration_enabled)
     values ($1, 'Hall', $2, '00:00', '23:00', $3, $4, $5, $6, $7, $8) returning id`,
    [name, extra.date || tomorrow, extra.capacity || 50, extra.status || 'published', extra.visibility || 'public',
     extra.category || 'general', extra.attendance ?? true, extra.registration ?? true]
  )).rows[0].id
const peopleByPhone = async (phone) => (await db.query(`select count(*)::int n from public.people where phone = $1`, [phone])).rows[0].n

// ---- 8.1 Members --------------------------------------------------------------------
const m1 = await A('admin_create_member', { p_full_name: 'Esther Wambui Kamau', p_phone: '0702 499 324', p_email: 'esther@example.com', p_gender: 'female', p_ministry: 'Choir' })
check('an administrator registers a new member', m1.ok === true && /^M-\d{5}$/.test(m1.label), JSON.stringify(m1))
const dupPhone = await A('admin_create_member', { p_full_name: 'Someone Else', p_phone: '+254702499324' })
check('+254702499324 and 0702499324 are the same phone number: duplicate refused',
  dupPhone.error === 'duplicate_phone' && dupPhone.existing?.id === m1.id, JSON.stringify(dupPhone))
check('the duplicate was not created', (await peopleByPhone('+254702499324')) === 1)
const dupName = await A('admin_create_member', { p_full_name: 'Esther Kamau', p_phone: '0733 111 222' })
check('a likely duplicate (similar name) is flagged for review, not created',
  dupName.error === 'possible_duplicate' && dupName.matches?.length === 1 && dupName.matches[0].reasons.includes('similar_name'), JSON.stringify(dupName))
const dupForced = await A('admin_create_member', { p_full_name: 'Esther Kamau', p_phone: '0733 111 222', p_force: true })
check('an administrator can still create it after reviewing', dupForced.ok === true, JSON.stringify(dupForced))
check('a one-word name does not match everyone with that first name',
  (await A('admin_create_member', { p_full_name: 'Esther Njeri', p_phone: '0733 111 333' })).ok === true)
check('invalid phone refused', (await A('admin_create_member', { p_full_name: 'No Phone', p_phone: '12' })).error === 'invalid_phone')
check('optional contact details stay optional (no email, no alt phone)',
  (await A('admin_create_member', { p_full_name: 'Plain Member', p_phone: '0733 111 444' })).ok === true)
check('a manager cannot register members',
  await denied(() => M('admin_create_member', { p_full_name: 'Not Allowed', p_phone: '0700 000 001' })))
check('an ordinary signed-in user cannot register members',
  await denied(() => as('authenticated', () => rpc('admin_create_member', { p_full_name: 'Not Allowed', p_phone: '0700 000 002' }), { uid: '99999999-9999-9999-9999-999999999999' })))
check('the public cannot read the people directory directly',
  await denied(() => as('anon', () => db.query('select * from public.people'))))
const dirList = await A('admin_list_people', { p_kind: 'member', p_search: 'esther' })
check('the directory searches by name', dirList.total === 3 && dirList.rows.some((r) => r.id === m1.id), JSON.stringify(dirList.total))
check('the directory searches by phone in any format', (await A('admin_list_people', { p_kind: 'all', p_search: '0702499324' })).rows[0]?.id === m1.id)
check('the directory searches by member number', (await A('admin_list_people', { p_kind: 'all', p_search: m1.label })).rows[0]?.id === m1.id)
const upd = await A('admin_update_person', { p_id: m1.id, p_full_name: 'Esther Wambui Kamau', p_phone: '0702499324', p_email: 'esther.k@example.com', p_ministry: 'Choir and Ushers' })
check('a member can be edited', upd.ok === true)
check('editing to a phone that belongs to someone else is refused',
  (await A('admin_update_person', { p_id: m1.id, p_full_name: 'Esther Wambui Kamau', p_phone: '0733 111 444' })).error === 'duplicate_phone')

// ---- 8.2 Events and their two links --------------------------------------------------------
const evPub = await newEvent('Sunday Service')
const evPriv = await newEvent('Leaders Retreat', { visibility: 'private', category: 'leadership' })
const evInt = await newEvent('Internal Prayer Meeting', { visibility: 'internal', category: 'prayer' })
const listed = await as('anon', () => db.query('select id from public.public_events'))
check('public events are listed', listed.rows.some((r) => r.id === evPub))
check('private and internal events are never listed publicly',
  !listed.rows.some((r) => r.id === evPriv || r.id === evInt))
const links = await A('admin_event_links', { p_event_id: evPriv })
check('both event links are generated automatically',
  links.ok && links.registration_link?.token?.length === 64 && links.attendance_links.length === 1 && links.attendance_links[0].token?.length === 64, JSON.stringify(links).slice(0, 200))
const regTok = links.registration_link.token
const attTok = links.attendance_links[0].token
check('links are long unpredictable tokens, different from each other', regTok !== attTok && /^[0-9a-f]{64}$/.test(regTok))
check('the page for a registration link shows only that event',
  (await U('registration_link_event', { p_token: regTok })).event?.name === 'Leaders Retreat')
check('a private event cannot be registered for by its id (no public door)',
  (await reg(evPriv, 80, {}, { ip: '10.8.1.1' })).error === 'event_unavailable')
const viaLink = await U('register_via_link', { p_token: regTok, p_full_name: 'Visiting Vera', p_email: '', p_phone: '0744 000 111', p_church_name: 'Grace Chapel', p_consent: true }, '10.8.1.2')
check('a first-time visitor registers through the registration link', viaLink.ok === true, JSON.stringify(viaLink))
const vera = (await db.query(`select * from public.people where phone = '+254744000111'`)).rows[0]
check('a visitor record is created (not a member)', vera?.kind === 'visitor' && /^V-\d{5}$/.test(`V-${String(vera.person_no).padStart(5, '0')}`))
check('registering does NOT count as attendance',
  (await db.query(`select count(*)::int n from public.attendance where person_id = $1`, [vera.id])).rows[0].n === 0)
check('a registration link cannot be used for attendance',
  (await U('volunteer_search_people', { p_token: regTok, p_query: 'Vera' })).error === 'invalid_access')
check('an attendance link cannot be used to register',
  (await U('register_via_link', { p_token: attTok, p_full_name: 'Sneaky One', p_email: '', p_phone: '0744 000 112', p_church_name: 'X Church', p_consent: true }, '10.8.1.3')).error === 'invalid_link')
check('an invalid registration link is refused', (await U('registration_link_event', { p_token: 'x'.repeat(40) })).error === 'invalid_link')
check('consent is still required through the link',
  (await U('register_via_link', { p_token: regTok, p_full_name: 'No Consent', p_email: '', p_phone: '0744 000 113', p_church_name: 'X Church', p_consent: false }, '10.8.1.4')).error === 'consent_required')

// returning visitor: same person, a second event, the phone written differently
const regTok2 = (await A('admin_event_links', { p_event_id: evPub })).registration_link.token
const again = await U('register_via_link', { p_token: regTok2, p_full_name: 'Vera Visiting', p_email: '', p_phone: '+254744000111', p_church_name: 'Grace Chapel', p_consent: true }, '10.8.1.5')
check('a returning visitor registers for another event', again.ok === true, JSON.stringify(again))
check('no second profile is created for the same phone', (await peopleByPhone('+254744000111')) === 1)
check('both registrations belong to the one visitor',
  (await db.query(`select count(distinct person_id)::int n, count(*)::int c from public.registrations where phone = '+254744000111'`)).rows[0].n === 1)
const veraAfter = (await db.query(`select needs_review from public.people where id = $1`, [vera.id])).rows[0]
check('a similar name is accepted without any flag', veraAfter.needs_review === false)
const diffName = await U('register_via_link', { p_token: regTok2, p_full_name: 'Totally Different Person', p_email: '', p_phone: '0744 000 114', p_church_name: 'X Church', p_consent: true }, '10.8.1.6')
await U('register_via_link', { p_token: (await A('admin_event_links', { p_event_id: evInt })).registration_link.token, p_full_name: 'Another Name Entirely', p_email: '', p_phone: '0744000114', p_church_name: 'X Church', p_consent: true }, '10.8.1.7')
check('the same phone with a very different name is flagged for review, not merged',
  (await db.query(`select needs_review, count(*) over () c from public.people where phone = '+254744000114'`)).rows[0].needs_review === true
  && (await peopleByPhone('+254744000114')) === 1)
check('flagged people can be listed for review', (await A('admin_list_people', { p_kind: 'all', p_review: true })).rows.some((r) => r.phone === '+254744000114'))

// link management
const regen = await A('admin_registration_link', { p_event_id: evPriv, p_action: 'regenerate' })
check('regenerating the registration link works', regen.ok && regen.token && regen.token !== regTok)
check('the old registration link stops working',
  (await U('registration_link_event', { p_token: regTok })).error === 'invalid_link' || (await U('registration_link_event', { p_token: regTok })).error === 'revoked')
check('the new registration link works', (await U('registration_link_event', { p_token: regen.token })).ok === true)
await A('admin_registration_link', { p_event_id: evPriv, p_action: 'disable' })
check('a disabled registration link is refused', (await U('registration_link_event', { p_token: regen.token })).ok === false)
check('a link can be created again after disabling', (await A('admin_registration_link', { p_event_id: evPriv, p_action: 'create' })).ok === true)
const evNoReg = await newEvent('Registration Closed Meeting', { registration: false })
const tokNoReg = (await A('admin_event_links', { p_event_id: evNoReg })).registration_link.token
check('registration can be switched off for an event',
  (await U('register_via_link', { p_token: tokNoReg, p_full_name: 'Late Larry', p_email: '', p_phone: '0744 000 115', p_church_name: 'X Church', p_consent: true }, '10.8.1.8')).error === 'registration_disabled')
check('the link page says registration is unavailable', (await U('registration_link_event', { p_token: tokNoReg })).event?.registration_state === 'unavailable')
const expLink = await A('admin_registration_link', { p_event_id: evInt, p_action: 'regenerate', p_expires_at: new Date(Date.now() + 3600000).toISOString() })
await db.query(`update public.volunteer_access set expires_at = now() - interval '1 minute' where kind = 'registration' and event_id = $1 and revoked_at is null`, [evInt])
check('an expired registration link is refused', (await U('registration_link_event', { p_token: expLink.token })).error === 'expired')
check('managers cannot manage links', await denied(() => M('admin_event_links', { p_event_id: evPub })))

// ---- 8.3 Ushers: search and check in -----------------------------------------------------
const linksPub = await A('admin_event_links', { p_event_id: evPub })
const ushTok = linksPub.attendance_links[0].token
const sTooShort = await U('volunteer_search_people', { p_token: ushTok, p_query: 'es' })
check('search needs at least 3 characters', sTooShort.error === 'query_too_short')
const byName = await U('volunteer_search_people', { p_token: ushTok, p_query: 'wambui' })
check('an usher finds a member by name', byName.ok && byName.results.some((r) => r.person_id === m1.id && r.kind === 'member'), JSON.stringify(byName))
const byPhone = await U('volunteer_search_people', { p_token: ushTok, p_query: '0702 499 324' })
check('an usher finds a member by phone number', byPhone.results.some((r) => r.person_id === m1.id))
check('the full phone number is never shown to ushers',
  !JSON.stringify(byName).includes('702499324') && byName.results[0].phone_hint.endsWith('324'))
const veraFound = await U('volunteer_search_people', { p_token: ushTok, p_query: 'vera' })
check('registered visitors are found too, marked as registered', veraFound.results.some((r) => r.person_id === vera.id && r.kind === 'visitor' && r.registered === true))
const ci1 = await U('volunteer_check_in_person', { p_token: ushTok, p_person_id: m1.id })
check('an usher marks a member present', ci1.ok && ci1.result === 'checked_in' && ci1.kind === 'member', JSON.stringify(ci1))
const ci2 = await U('volunteer_check_in_person', { p_token: ushTok, p_person_id: m1.id })
check('the same person cannot be counted twice for one event', ci2.ok && ci2.result === 'already_checked_in')
check('exactly one attendance record exists',
  (await db.query(`select count(*)::int n from public.attendance where event_id = $1 and person_id = $2`, [evPub, m1.id])).rows[0].n === 1)
const ci3 = await U('volunteer_check_in_person', { p_token: ushTok, p_person_id: vera.id })
check('an usher checks in a registered visitor', ci3.ok && ci3.result === 'checked_in' && ci3.kind === 'visitor')
const veraAtt = (await db.query(`select registration_id, classification from public.attendance where event_id = $1 and person_id = $2`, [evPub, vera.id])).rows[0]
check('the visitor attendance is linked to their registration and classed as a visitor',
  veraAtt.registration_id !== null && veraAtt.classification === 'visitor')
check('the event page counts show members and visitors separately',
  await (async () => { const e = await U('volunteer_event', { p_token: ushTok }); return e.members_present === 1 && e.visitors_present === 1 && e.checked_in === 2 && e.registered === 2 })())

// walk-ins
const w1 = await U('volunteer_register_walkin', { p_token: ushTok, p_full_name: 'Walk In Wanjiru', p_phone: '0755 666 777', p_church_name: '', p_consent: true })
check('an usher registers and checks in a walk-in visitor in one step', w1.ok && w1.result === 'checked_in' && w1.kind === 'visitor' && w1.matched_existing === false, JSON.stringify(w1))
const wRow = (await db.query(`select a.registration_id, a.classification, a.method, p.kind from public.attendance a join public.people p on p.id = a.person_id where p.phone = '+254755666777'`)).rows[0]
check('the walk-in has a visitor profile and an attendance record', wRow && wRow.kind === 'visitor' && wRow.classification === 'visitor' && wRow.method === 'walkin' && wRow.registration_id === null)
const w2 = await U('volunteer_register_walkin', { p_token: ushTok, p_full_name: 'Walk In Wanjiru', p_phone: '+254755666777', p_consent: true })
check('registering the same walk-in again does not duplicate them or their attendance',
  w2.result === 'already_checked_in' && w2.matched_existing === true && (await peopleByPhone('+254755666777')) === 1)
const w3 = await U('volunteer_register_walkin', { p_token: ushTok, p_full_name: 'Esther Kamau', p_phone: '0702 499 324', p_consent: true })
check('a walk-in who is already a member is found, not duplicated', w3.matched_existing === true && w3.kind === 'member')
check('a walk-in needs consent', (await U('volunteer_register_walkin', { p_token: ushTok, p_full_name: 'No Consent Nora', p_phone: '0755 666 778', p_consent: false })).error === 'consent_required')
check('a walk-in needs a valid phone', (await U('volunteer_register_walkin', { p_token: ushTok, p_full_name: 'Bad Phone', p_phone: '12', p_consent: true })).error === 'invalid_phone')
check('a walk-in needs a valid email if one is given', (await U('volunteer_register_walkin', { p_token: ushTok, p_full_name: 'Bad Mail', p_phone: '0755 666 779', p_email: 'nope', p_consent: true })).error === 'invalid_email')
const noWalkTok = (await A('admin_create_volunteer_link', { p_event_id: evPub, p_label: 'Door without walk-ins', p_expires_at: new Date(Date.now() + 86400000).toISOString(), p_allow_walkins: false })).token
check('a link without walk-in permission cannot register new visitors',
  (await U('volunteer_register_walkin', { p_token: noWalkTok, p_full_name: 'Not Allowed Ned', p_phone: '0755 666 780', p_consent: true })).error === 'walkins_not_allowed')
check('...but it can still check people in', (await U('volunteer_check_in_person', { p_token: noWalkTok, p_person_id: m1.id })).result === 'already_checked_in')

// link states
const revokeTarget = await A('admin_create_volunteer_link', { p_event_id: evPub, p_label: 'To revoke', p_expires_at: new Date(Date.now() + 86400000).toISOString() })
await A('admin_revoke_volunteer_link', { p_access_id: revokeTarget.id })
check('a revoked attendance link stops working', (await U('volunteer_search_people', { p_token: revokeTarget.token, p_query: 'esther' })).error === 'revoked')
const expTarget = await A('admin_create_volunteer_link', { p_event_id: evPub, p_label: 'To expire', p_expires_at: new Date(Date.now() + 86400000).toISOString() })
await db.query(`update public.volunteer_access set expires_at = now() - interval '1 minute' where id = $1`, [expTarget.id])
check('an expired attendance link stops working', (await U('volunteer_search_people', { p_token: expTarget.token, p_query: 'esther' })).error === 'expired')
check('a made-up token is refused', (await U('volunteer_search_people', { p_token: 'y'.repeat(40), p_query: 'esther' })).error === 'invalid_access')
const evNoAtt = await newEvent('No Attendance Event', { attendance: false })
const noAttTok = (await A('admin_event_links', { p_event_id: evNoAtt })).attendance_links[0].token
check('attendance can be switched off for an event',
  (await U('volunteer_check_in_person', { p_token: noAttTok, p_person_id: m1.id })).error === 'attendance_disabled')
const evFar2 = await newEvent('Next Month Meeting', { date: daysAhead(40) })
const farTok = (await A('admin_event_links', { p_event_id: evFar2 })).attendance_links[0].token
check('check-in outside its window is refused with a clear message',
  (await U('volunteer_check_in_person', { p_token: farTok, p_person_id: m1.id })).error === 'outside_window')
const inactive = await A('admin_create_member', { p_full_name: 'Retired Ruth Muthoni', p_phone: '0733 999 000' })
await A('admin_set_person_status', { p_id: inactive.id, p_status: 'inactive' })
check('inactive members no longer appear in usher search',
  !(await U('volunteer_search_people', { p_token: ushTok, p_query: 'retired' })).results.length)
check('an inactive member cannot be checked in', (await U('volunteer_check_in_person', { p_token: ushTok, p_person_id: inactive.id })).error === 'not_found')
await A('admin_set_person_status', { p_id: inactive.id, p_status: 'active' })
check('an inactive member can be activated again', (await U('volunteer_search_people', { p_token: ushTok, p_query: 'retired' })).results.length === 1)

// ---- 8.4 Event report, correction and conversion ------------------------------------------------
const rep1 = await A('admin_event_attendance_report', { p_event_id: evPub })
check('the event report separates attended members from attended visitors',
  rep1.ok && rep1.attended_members.length === 1 && rep1.attended_visitors.length === 2 && rep1.totals.unique_attendees === 3, JSON.stringify(rep1.totals))
check('the report lists the member under members and visitors under visitors',
  rep1.attended_members[0].person_id === m1.id && rep1.attended_visitors.some((v) => v.person_id === vera.id))
check('attendance without prior registration is counted separately', rep1.totals.attended_without_registering >= 2)
const regOnlyEv = await newEvent('Registered But Absent')
const absTok = (await A('admin_event_links', { p_event_id: regOnlyEv })).registration_link.token
await U('register_via_link', { p_token: absTok, p_full_name: 'Absent Abel', p_email: '', p_phone: '0766 000 001', p_church_name: 'X Church', p_consent: true }, '10.8.2.1')
const rep2 = await A('admin_event_attendance_report', { p_event_id: regOnlyEv })
check('registered visitors who did not attend are listed separately',
  rep2.registered_visitors_not_attended.length === 1 && rep2.totals.attended_visitors === 0 && rep2.totals.attendance_percentage === 0)
check('members who did not register are not treated as absent', rep2.registered_members_not_attended.length === 0 && rep2.totals.registered_members === 0)
const repMgr = await M('admin_event_attendance_report', { p_event_id: evPub })
check('a manager can see the event report with phone numbers masked',
  repMgr.ok && repMgr.full_phone_numbers === false && !JSON.stringify(repMgr).includes('702499324'))
check('an administrator sees full phone numbers', rep1.full_phone_numbers === true && JSON.stringify(rep1).includes('+254702499324'))
check('an ordinary user cannot read the report',
  await denied(() => as('authenticated', () => rpc('admin_event_attendance_report', { p_event_id: evPub }), { uid: '99999999-9999-9999-9999-999999999999' })))

// manual correction (managers are allowed)
const corr = await M('admin_set_person_attendance', { p_event_id: evPub, p_person_id: vera.id, p_present: false, p_reason: 'Marked by mistake' })
check('a manager can correct attendance', corr.ok && corr.result === 'removed')
const kept = (await db.query(`select action, reason, classification, original_checked_in_by from public.attendance_corrections where person_id = $1 and event_id = $2`, [vera.id, evPub])).rows
check('the removed record is kept in the correction history', kept.length === 1 && kept[0].action === 'removed' && kept[0].reason === 'Marked by mistake' && kept[0].classification === 'visitor')
check('the person is no longer counted', (await db.query(`select count(*)::int n from public.attendance where event_id = $1 and person_id = $2`, [evPub, vera.id])).rows[0].n === 0)
await M('admin_set_person_attendance', { p_event_id: evPub, p_person_id: vera.id, p_present: true, p_reason: 'Re-added' })
check('attendance can be restored, and the history keeps both steps',
  (await db.query(`select count(*)::int n from public.attendance_corrections where person_id = $1`, [vera.id])).rows[0].n === 2)
check('an ordinary user cannot change attendance',
  await denied(() => as('authenticated', () => rpc('admin_set_person_attendance', { p_event_id: evPub, p_person_id: vera.id, p_present: false }), { uid: '99999999-9999-9999-9999-999999999999' })))

// visitor -> member
const veraBefore = await A('admin_get_person', { p_id: vera.id })
check('a visitor profile shows registrations and attendance history', veraBefore.registrations.length === 2 && veraBefore.history.length === 1)
check('a manager cannot convert a visitor', await denied(() => M('admin_convert_visitor', { p_id: vera.id, p_full_name: 'Vera Visiting', p_phone: '0744000111' })))
const conv = await A('admin_convert_visitor', { p_id: vera.id, p_full_name: 'Vera Visiting', p_phone: '0744 000 111', p_email: 'vera@example.com', p_ministry: 'Hospitality' })
check('an administrator converts a visitor into a member', conv.ok === true && /^M-/.test(conv.label), JSON.stringify(conv))
check('conversion keeps the same person (no second profile)', conv.id === vera.id && (await peopleByPhone('+254744000111')) === 1)
check('conversion keeps registrations and attendance', conv.registrations_kept === 2 && conv.attendance_kept === 1)
check('the person now appears as a member',
  (await A('admin_list_people', { p_kind: 'member', p_search: 'vera' })).rows.some((r) => r.id === vera.id))
check('and no longer in the visitors list', !(await A('admin_list_people', { p_kind: 'visitor', p_search: 'vera' })).rows.some((r) => r.id === vera.id))
const repOld = await A('admin_event_attendance_report', { p_event_id: evPub })
check('the old event still classes them as a visitor (history is preserved)',
  repOld.attended_visitors.some((v) => v.person_id === vera.id && v.now_member === true) && !repOld.attended_members.some((v) => v.person_id === vera.id))
const evAfter = await newEvent('After Conversion Service')
const tokAfter = (await A('admin_event_links', { p_event_id: evAfter })).attendance_links[0].token
const afterSearch = await U('volunteer_search_people', { p_token: tokAfter, p_query: 'vera' })
check('future searches find them as a member', afterSearch.results[0]?.kind === 'member')
await U('volunteer_check_in_person', { p_token: tokAfter, p_person_id: vera.id })
check('new attendance is recorded as a member',
  (await db.query(`select classification from public.attendance where event_id = $1 and person_id = $2`, [evAfter, vera.id])).rows[0].classification === 'member')
check('a member cannot be converted again', (await A('admin_convert_visitor', { p_id: vera.id, p_full_name: 'Vera Visiting', p_phone: '0744000111' })).error === 'already_member')
const w4 = (await db.query(`select id from public.people where phone = '+254755666777'`)).rows[0].id
check('conversion cannot take a phone number that belongs to someone else',
  (await A('admin_convert_visitor', { p_id: w4, p_full_name: 'Walk In Wanjiru', p_phone: '0702499324' })).error === 'duplicate_phone')
check('the conversion is recorded in the audit log',
  (await db.query(`select count(*)::int n from public.audit_log where action = 'visitor_converted'`)).rows[0].n === 1)
const profile = await A('admin_get_person', { p_id: vera.id })
check('the member profile shows attendance history and the year total',
  profile.history.length === 2 && profile.year_total >= 2 && profile.history.some((h) => h.classification === 'visitor') && profile.history.some((h) => h.classification === 'member'))
const lapsed = await A('admin_lapsed_members', { p_days: 30 })
check('members who have not attended recently can be listed',
  lapsed.ok && lapsed.rows.some((r) => r.full_name === 'Plain Member') && !lapsed.rows.some((r) => r.person_id === m1.id))
const none = await A('admin_list_people', { p_kind: 'member', p_attended: 'none', p_from: '2000-01-01', p_to: '2100-01-01' })
check('members with no attendance in a period can be filtered', none.rows.some((r) => r.full_name === 'Plain Member') && !none.rows.some((r) => r.id === m1.id))
check('repeat visitors can be found',
  (await A('admin_list_people', { p_kind: 'visitor', p_min_attended: 1 })).rows.every((r) => r.attended_total >= 1))

// ---- 8.5 Annual ranking -----------------------------------------------------------------------------
const yr = 2019
const mkEv = async (name, date, extra = {}) => (await db.query(
  `insert into public.events (name, venue, event_date, start_time, capacity, status, category, attendance_enabled)
   values ($1, 'Hall', $2, '10:00', 50, $3, $4, $5) returning id`,
  [name, date, extra.status || 'published', extra.category || 'service', extra.attendance ?? true])).rows[0].id
const y1 = await mkEv('Y Jan Service', '2019-01-06')
const y2 = await mkEv('Y Feb Prayer', '2019-02-10', { category: 'prayer' })
const y3 = await mkEv('Y Mar Service', '2019-03-10')
const y4 = await mkEv('Y Apr Training', '2019-04-14', { category: 'training', status: 'completed' })
const yCancelled = await mkEv('Y Cancelled', '2019-05-05', { status: 'cancelled' })
const yDraft = await mkEv('Y Draft', '2019-05-12', { status: 'draft' })
const yNoAtt = await mkEv('Y No Tracking', '2019-06-02', { attendance: false })
const yNext = await mkEv('Y Next Year', '2020-01-05')
const mk = async (name, phone, kind = 'member') => (await db.query(
  `insert into public.people (kind, full_name, phone, status) values ($1, $2, $3, 'active') returning id`, [kind, name, phone])).rows[0].id
const rA = await mk('Rank Alpha', '+254790000001')
const rB = await mk('Rank Bravo', '+254790000002')
const rC = await mk('Rank Charlie', '+254790000003')
const rD = await mk('Rank Delta', '+254790000004')
const rE = await mk('Rank Echo', '+254790000005')
const rV = await mk('Rank Visitor', '+254790000006', 'visitor')
const attend = (ev, p) => db.query(`insert into public.attendance (event_id, person_id, method, checked_in_by) values ($1, $2, 'admin', 'test') on conflict do nothing`, [ev, p])
for (const ev of [y1, y2, y3, yCancelled, yDraft, yNoAtt, yNext]) await attend(ev, rA)  // A: 3 counted meetings
for (const ev of [y1, y4]) await attend(ev, rB)                                         // B: 2
for (const ev of [y2, y3]) await attend(ev, rC)                                         // C: 2 (tie with B)
await attend(y1, rD)                                                                    // D: 1
await attend(y1, rD)                                                                    // duplicate attempt
await attend(y1, rV); await attend(y2, rV)                                              // a visitor: 2
check('duplicate check-in attempts leave one record', (await db.query(`select count(*)::int n from public.attendance where event_id = $1 and person_id = $2`, [y1, rD])).rows[0].n === 1)
const rk = await A('admin_annual_attendance', { p_year: yr })
const rankOf = (res, name) => res.ranking.find((r) => r.full_name === name)
check('members are ranked by distinct meetings attended in the year',
  rankOf(rk, 'Rank Alpha').meetings_attended === 3 && rankOf(rk, 'Rank Bravo').meetings_attended === 2 && rankOf(rk, 'Rank Delta').meetings_attended === 1, JSON.stringify(rk.ranking.filter((r) => r.full_name.startsWith('Rank '))))
check('cancelled, draft, no-tracking and other-year events do not count', rankOf(rk, 'Rank Alpha').meetings_attended === 3)
check('ranks run highest to lowest with ties sharing a rank',
  rankOf(rk, 'Rank Alpha').rank < rankOf(rk, 'Rank Bravo').rank && rankOf(rk, 'Rank Bravo').rank === rankOf(rk, 'Rank Charlie').rank
  && rankOf(rk, 'Rank Delta').rank === rankOf(rk, 'Rank Bravo').rank + 2)
check('zero-attendance members are listed when requested and ranked last',
  rankOf(rk, 'Rank Echo')?.meetings_attended === 0 && rankOf(rk, 'Rank Echo').rank > rankOf(rk, 'Rank Delta').rank)
const rkNoZero = await A('admin_annual_attendance', { p_year: yr, p_include_zero: false })
check('zero-attendance members can be left out', !rankOf(rkNoZero, 'Rank Echo') && rkNoZero.ranking.every((r) => r.meetings_attended > 0))
check('visitors are not mixed into the member ranking', !rankOf(rk, 'Rank Visitor'))
const rkV = await A('admin_annual_attendance', { p_year: yr, p_scope: 'visitors' })
check('visitors have their own ranking', rankOf(rkV, 'Rank Visitor')?.meetings_attended === 2 && !rankOf(rkV, 'Rank Alpha'))
const rkAll = await A('admin_annual_attendance', { p_year: yr, p_scope: 'all' })
check('an all-attendees view includes both', !!rankOf(rkAll, 'Rank Visitor') && !!rankOf(rkAll, 'Rank Alpha'))
const rkPrayer = await A('admin_annual_attendance', { p_year: yr, p_category: 'prayer' })
check('the ranking can be filtered by event category', rankOf(rkPrayer, 'Rank Alpha')?.meetings_attended === 1 && rankOf(rkPrayer, 'Rank Charlie')?.meetings_attended === 1 && !rankOf(rkPrayer, 'Rank Bravo')?.meetings_attended)
check('the year is taken from the event date', (await A('admin_annual_attendance', { p_year: 2020 })).ranking.find((r) => r.full_name === 'Rank Alpha')?.meetings_attended === 1)
const activeMembers = (await db.query(`select count(*)::int n from public.people where kind = 'member' and status = 'active'`)).rows[0].n
check('the annual summary is computed from real records',
  rk.summary.meetings_held === 4 && rk.summary.active_members === activeMembers
  && rk.summary.member_attendance_records === 8 && rk.summary.members_attended_any === 4
  && rk.summary.members_attended_none === activeMembers - 4 && rk.summary.visitors_attended_any === 1, JSON.stringify(rk.summary))
check('participation rate = member attendances / (meetings x active members)',
  Math.abs(rk.summary.participation_rate - Math.round(1000 * 8 / (4 * activeMembers)) / 10) < 0.11, String(rk.summary.participation_rate))
check('attendance by month and category are reported',
  rk.monthly.length === 12 && rk.monthly[0].meetings === 1 && rk.monthly[0].member_attendance >= 3 && rk.categories.some((c) => c.category === 'prayer'))
check('the previous year is available for comparison', rk.previous.year === 2018 && rk.previous.meetings === 0)
check('rankings are administrator-only', await denied(() => M('admin_annual_attendance', { p_year: yr })))
check('rankings are not public', await denied(() => as('anon', () => rpc('admin_annual_attendance', { p_year: yr }))))
check('an invalid year is refused', (await A('admin_annual_attendance', { p_year: 1 })).error === 'invalid_year')

// ---- 8.6 Existing behaviour keeps working -----------------------------------------------------------
const evQr = await newEvent('QR Regression Event')
const qrTok = (await A('admin_event_links', { p_event_id: evQr })).attendance_links[0].token
const qrReg = await reg(evQr, 90, {}, { ip: '10.8.3.1' })
const qrCi = await U('volunteer_check_in_qr', { p_token: qrTok, p_code: qrReg.qr_token })
check('QR check-in still works and records the person', qrCi.ok && qrCi.result === 'checked_in')
check('QR attendance carries the person and classification',
  (await db.query(`select person_id is not null as p, classification from public.attendance where event_id = $1`, [evQr])).rows[0].classification === 'visitor')
const qrList = await M('admin_list_registrations', { p_event_id: evQr })
check('managers can view an event\'s registrations, with the person classification', qrList.ok && qrList.rows[0].classification === 'visitor' && qrList.rows[0].checked_in_at)
check('managers cannot cancel registrations', await denied(() => M('admin_cancel_registration', { p_registration_id: qrList.rows[0].id })))
check('managers cannot create events',
  await denied(() => as('authenticated', () => db.query(`insert into public.events (name, venue, event_date, start_time, capacity) values ('Mgr Event', 'x', '2030-01-01', '10:00', 5)`), { uid: managerId })))
check('managers can read events', (await as('authenticated', () => db.query('select count(*)::int n from public.events'), { uid: managerId })).rows[0].n > 0)
const mgrRole = await as('authenticated', () => rpc('my_role', {}), { uid: managerId })
check('my_role reports the signed-in role', mgrRole === 'manager' && (await as('authenticated', () => rpc('my_role', {}), { uid: adminId })) === 'admin')
check('removing attendance by cancelling a registration keeps a copy',
  await (async () => { await A('admin_cancel_registration', { p_registration_id: qrList.rows[0].id });
    return (await db.query(`select count(*)::int n from public.attendance_corrections where event_id = $1 and action = 'removed'`, [evQr])).rows[0].n === 1 })())
const overview2 = await A('admin_reports_overview', {})
check('the reports overview carries member and visitor attendance', overview2.events.some((e) => e.members_attended >= 1 && e.unique_attendees >= 1))
const stats2 = await A('admin_dashboard_stats', {})
check('dashboard stats include members and visitors', stats2.total_members >= 5 && stats2.total_visitors >= 1)
// ---- 8.7 Staff look-ups and what managers may see ------------------------------------------------
const ss = await M('staff_search_people', { p_event_id: evQr, p_query: 'wambui' })
check('a manager can search people to correct attendance, with masked phone numbers',
  ss.ok && ss.results.some((r) => r.person_id === m1.id) && !JSON.stringify(ss).includes('702499324'))
const ssAdmin = await A('staff_search_people', { p_event_id: evQr, p_query: 'wambui' })
check('an administrator sees the full phone number there', JSON.stringify(ssAdmin).includes('+254702499324'))
check('staff search needs 3 characters', (await M('staff_search_people', { p_event_id: evQr, p_query: 'ab' })).error === 'query_too_short')
check('an ordinary user cannot use staff search',
  await denied(() => as('authenticated', () => rpc('staff_search_people', { p_event_id: evQr, p_query: 'wambui' }), { uid: '99999999-9999-9999-9999-999999999999' })))
check('the public cannot use staff search', await denied(() => as('anon', () => rpc('staff_search_people', { p_event_id: evQr, p_query: 'wambui' }))))
const mgrList = await M('admin_list_registrations', { p_event_id: evPub })
check('a manager sees masked phone numbers and no email addresses in the participant list',
  mgrList.ok && mgrList.rows.length > 0 && mgrList.rows.every((r) => r.phone.startsWith('•') && !r.email))
const admList = await A('admin_list_registrations', { p_event_id: evPub })
check('an administrator sees full phone numbers in the participant list', admList.rows.every((r) => r.phone.startsWith('+254')))
const evPersonal = await newEvent('Personal Data Event')
check('registrations cannot be read directly through the API by the public',
  await denied(() => as('anon', () => db.query('select * from public.registrations'))))
check('the correction history cannot be read by the public',
  await denied(() => as('anon', () => db.query('select * from public.attendance_corrections'))))
check('event links (secret tokens) cannot be read through the API',
  await denied(() => as('authenticated', () => db.query('select token_plain from public.volunteer_access'), { uid: adminId })))


}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
