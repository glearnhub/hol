// Upgrade test: builds a database with the PREVIOUS version of the SQL (before members,
// visitors and event links existed), fills it with data, applies the current SQL and
// checks that nothing was lost and everything is linked to people.
//
//   cd tests && npm test            (runs this together with db.test.mjs)
//
// The previous SQL is read from git (commit OLD below), so this test needs the git history.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const OLD = '0088ca9' // "Registration: email address is optional": the last version before the enhancement
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')
const oldSql = (f) => execFileSync('git', ['show', `${OLD}:sql/${f}`], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 })
const newSql = (f) => readFileSync(path.join(repo, 'sql', f), 'utf8')

for (const evt of ['uncaughtException', 'unhandledRejection']) {
  process.on(evt, (e) => {
    console.error('ERROR:', (e && e.message) || e)
    process.exit(1)
  })
}

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}`) } else { failed++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`) }
}

const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema auth, storage to anon, authenticated;
  grant select on storage.objects to anon;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`)

async function as(role, fn, { uid = '', ip = '10.0.0.1' } = {}) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid])
  await db.query(`select set_config('request.headers', $1, false)`, [JSON.stringify({ 'x-forwarded-for': ip })])
  if (role) await db.exec(`set role ${role}`)
  try { return await fn() } finally { await db.exec('reset role') }
}
async function rpc(fn, args) {
  const keys = Object.keys(args)
  const r = await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]))
  return r.rows[0].r
}

console.log(`Building the OLD database from commit ${OLD} ...`)
await db.exec(oldSql('schema.sql'))
await db.exec(oldSql('functions.sql'))
await db.exec(oldSql('policies.sql'))

const adminId = '11111111-1111-1111-1111-111111111111'
await db.exec(`
  insert into auth.users (id, email) values ('${adminId}', 'admin@example.com');
  insert into public.admin_roles (user_id) values ('${adminId}');
`)
const day = (await db.query(`select ((now() at time zone 'Africa/Nairobi')::date + 1)::text d`)).rows[0].d
const ev = async (name) => (await db.query(
  `insert into public.events (name, venue, event_date, start_time, end_time, capacity, status)
   values ($1, 'Hall', $2, '00:00', '23:00', 100, 'published') returning id`, [name, day])).rows[0].id
const e1 = await ev('Old Event One')
const e2 = await ev('Old Event Two')
const oldReg = (event, name, phone, ip) => as('anon', () => rpc('register_participant', {
  p_event_id: event, p_full_name: name, p_email: '', p_phone: phone, p_church_name: 'Grace Chapel', p_consent: true }), { ip })

const rGrace1 = await oldReg(e1, 'Grace Wanjiku', '0712 000 001', '10.1.0.1')
const rJoy1 = await oldReg(e1, 'Joy Akinyi', '0712 000 002', '10.1.0.2')
const rGrace2 = await oldReg(e2, 'Grace W. Wanjiku', '+254712000001', '10.1.0.3') // the same person at a second event
const rMary = await oldReg(e2, 'Mary Atieno', '0712 000 003', '10.1.0.4')
await db.query(`update public.registrations set status = 'cancelled' where registration_reference = $1`, [rMary.registration_reference])
const link = await as('authenticated', () => rpc('admin_create_volunteer_link', {
  p_event_id: e1, p_label: 'Old door', p_expires_at: new Date(Date.now() + 86400000 * 5).toISOString() }), { uid: adminId })
const ci = await as('anon', () => rpc('volunteer_check_in_qr', { p_token: link.token, p_code: rGrace1.qr_token }), { ip: '10.1.0.9' })
console.log('Old data ready:', JSON.stringify({ checkedIn: ci.result }))

const before = {
  registrations: (await db.query('select count(*)::int n from public.registrations')).rows[0].n,
  attendance: (await db.query('select count(*)::int n from public.attendance')).rows[0].n,
  distinctPhones: (await db.query('select count(distinct phone)::int n from public.registrations')).rows[0].n,
}

console.log('\nUpgrading with the current sql/*.sql (twice, to prove it is repeatable) ...')
for (let i = 0; i < 2; i++) {
  await db.exec(newSql('schema.sql'))
  await db.exec(newSql('functions.sql'))
  await db.exec(newSql('policies.sql'))
}

console.log('\nUpgrade checks')
const q = async (text, params) => (await db.query(text, params)).rows
check('no registration was lost', (await q('select count(*)::int n from public.registrations'))[0].n === before.registrations)
check('no attendance record was lost', (await q('select count(*)::int n from public.attendance'))[0].n === before.attendance)
check('one person per distinct phone number', (await q('select count(*)::int n from public.people'))[0].n === before.distinctPhones, JSON.stringify(await q('select phone, full_name from public.people')))
check('the same person at two events is one profile',
  (await q(`select count(distinct person_id)::int n from public.registrations where phone = '+254712000001'`))[0].n === 1)
check('every old registration is linked to a person', (await q('select count(*)::int n from public.registrations where person_id is null'))[0].n === 0)
check('old people are visitors until an administrator converts them',
  (await q(`select count(*)::int n from public.people where kind <> 'visitor'`))[0].n === 0
  && (await q(`select count(*)::int n from public.registrations where classification <> 'visitor'`))[0].n === 0)
check('the old attendance is linked to the person and classed as a visitor',
  (await q(`select person_id is not null as p, classification from public.attendance`))[0].classification === 'visitor')
check('person_id is now mandatory',
  (await q(`select is_nullable from information_schema.columns where table_name = 'registrations' and column_name = 'person_id'`))[0].is_nullable === 'NO')
check('the old check-in link still exists and kept its type',
  (await q(`select kind from public.volunteer_access where label = 'Old door'`))[0].kind === 'attendance')
check('every event now has a registration link and an attendance link',
  (await q(`select count(*)::int n from public.events e where
     exists (select 1 from public.volunteer_access v where v.event_id = e.id and v.kind = 'registration' and v.revoked_at is null)
     and exists (select 1 from public.volunteer_access v where v.event_id = e.id and v.kind = 'attendance' and v.auto_managed)`))[0].n === 2)
check('exactly one live registration link per event', (await q(`select count(*)::int n from public.volunteer_access where kind = 'registration' and revoked_at is null`))[0].n === 2)
check('events keep working defaults: public, tracked, open for registration',
  (await q(`select count(*)::int n from public.events where visibility = 'public' and attendance_enabled and registration_enabled and category = 'general'`))[0].n === 2)
const listing = await as('anon', () => db.query('select id from public.public_events'))
check('the public still sees the old events', listing.rows.length === 2)

// the old link still works with the new functions, and the old data shows up
const search = await as('anon', () => rpc('volunteer_search_people', { p_token: link.token, p_query: 'wanjiku' }), { ip: '10.1.1.1' })
check('the old check-in link works with the new search',
  search.ok && search.results.length === 1 && search.results[0].checked_in === true && search.results[0].kind === 'visitor', JSON.stringify(search))
const joy = (await q(`select id from public.people where full_name = 'Joy Akinyi'`))[0].id
const joyCi = await as('anon', () => rpc('volunteer_check_in_person', { p_token: link.token, p_person_id: joy }), { ip: '10.1.1.2' })
check('an old registrant can be checked in by search', joyCi.result === 'checked_in')
check('...and it is linked to their old registration',
  (await q(`select registration_id is not null as r from public.attendance where person_id = $1`, [joy]))[0].r === true)
const list = await as('authenticated', () => rpc('admin_list_registrations', { p_event_id: e1 }), { uid: adminId })
check('the old registrations list still works and shows who is present',
  list.ok && list.total === 2 && list.rows.filter((r) => r.checked_in_at).length === 2 && list.rows.every((r) => r.classification === 'visitor'))
const rep = await as('authenticated', () => rpc('admin_event_attendance_report', { p_event_id: e1 }), { uid: adminId })
check('the new event report works on migrated data', rep.ok && rep.totals.attended_visitors === 2 && rep.totals.attended_members === 0, JSON.stringify(rep.totals))
const grace = (await q(`select id from public.people where phone = '+254712000001'`))[0].id
const conv = await as('authenticated', () => rpc('admin_convert_visitor', { p_id: grace, p_full_name: 'Grace Wanjiku', p_phone: '0712000001' }), { uid: adminId })
check('a migrated visitor can be converted without losing history', conv.ok && conv.registrations_kept === 2 && conv.attendance_kept === 1, JSON.stringify(conv))
const rep2 = await as('authenticated', () => rpc('admin_event_attendance_report', { p_event_id: e1 }), { uid: adminId })
check('and the old event still lists them as a visitor', rep2.attended_visitors.some((v) => v.person_id === grace && v.now_member === true))
const stats = await as('authenticated', () => rpc('admin_dashboard_stats', {}), { uid: adminId })
check('dashboard figures are unchanged for old data', stats.total_registrations === 3 && stats.total_members === 1 && stats.total_visitors === 2, JSON.stringify(stats))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
