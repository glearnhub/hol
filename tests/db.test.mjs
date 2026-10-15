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

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
