// Upgrade test for the member-details change (residence, department, deaconess, membership
// type). It builds the database exactly as the PREVIOUS release made it (the version with
// members and visitors but with a "ministry" field), fills it, applies the current SQL and
// checks that what was typed is kept and the new fields work.
//
// The previous SQL is read from git (commit OLD below).
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const OLD = 'e20cf87' // the release that is live before this change
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')
const oldSql = (f) => execFileSync('git', ['show', `${OLD}:sql/${f}`], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 })
const newSql = (f) => readFileSync(path.join(repo, 'sql', f), 'utf8')

for (const evt of ['uncaughtException', 'unhandledRejection']) {
  process.on(evt, (e) => { console.error('ERROR:', (e && e.message) || e); process.exit(1) })
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

console.log(`Building the PREVIOUS release (${OLD}) ...`)
await db.exec(oldSql('schema.sql'))
await db.exec(oldSql('functions.sql'))
await db.exec(oldSql('policies.sql'))

const adminId = '11111111-1111-1111-1111-111111111111'
await db.exec(`
  insert into auth.users (id, email) values ('${adminId}', 'admin@example.com');
  insert into public.admin_roles (user_id) values ('${adminId}');
`)
const A = (fn, args) => as('authenticated', () => rpc(fn, args), { uid: adminId })

// members created the way the previous release did it (field called "ministry")
const m1 = await A('admin_create_member', { p_full_name: 'Esther Wambui Kamau', p_phone: '0702 499 324', p_ministry: 'Choir', p_church: 'Grace Chapel' })
const m2 = await A('admin_create_member', { p_full_name: 'Ruth Chebet', p_phone: '0711 000 002' })
const day = (await db.query(`select ((now() at time zone 'Africa/Nairobi')::date + 1)::text d`)).rows[0].d
const ev = (await db.query(`insert into public.events (name, venue, event_date, start_time, end_time, capacity, status)
  values ('Old Event', 'Hall', $1, '00:00', '23:00', 50, 'published') returning id`, [day])).rows[0].id
const reg = await as('anon', () => rpc('register_participant', { p_event_id: ev, p_full_name: 'Vera Visiting', p_email: '', p_phone: '0722 000 001', p_church_name: 'Grace Chapel', p_consent: true }), { ip: '10.1.0.1' })
await db.query(`insert into public.attendance (event_id, person_id, method, checked_in_by) values ($1, $2, 'admin', 'test')`, [ev, m1.id])
console.log('Previous release ready:', JSON.stringify({ members: 2, visitors: 1 }))

console.log('\nUpgrading with the current sql/*.sql (twice) ...')
for (let i = 0; i < 2; i++) {
  await db.exec(newSql('schema.sql'))
  await db.exec(newSql('functions.sql'))
  await db.exec(newSql('policies.sql'))
}

console.log('\nUpgrade checks')
const q = async (text, params) => (await db.query(text, params)).rows
const cols = (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'people'`)).map((r) => r.column_name)
check('"ministry" became "department"', cols.includes('department') && !cols.includes('ministry'))
check('what was typed in ministry is kept as the department',
  (await q(`select department from public.people where id = $1`, [m1.id]))[0].department === 'Choir')
check('the new fields exist', ['residence', 'deaconess_id', 'membership_type'].every((c) => cols.includes(c)))
check('existing members become the type Member',
  (await q(`select count(*)::int n from public.people where kind = 'member' and membership_type = 'member'`))[0].n === 2)
check('existing visitors stay visitors',
  (await q(`select membership_type from public.people where full_name = 'Vera Visiting'`))[0].membership_type === 'visitor')
check('nothing was lost: people, registrations and attendance are unchanged',
  (await q('select count(*)::int n from public.people'))[0].n === 3
  && (await q('select count(*)::int n from public.registrations'))[0].n === 1
  && (await q('select count(*)::int n from public.attendance'))[0].n === 1)
check('the old attendance is still attached to the member',
  (await q(`select classification from public.attendance where person_id = $1`, [m1.id]))[0].classification === 'member')

const list = await A('admin_list_people', { p_kind: 'member' })
check('the directory lists them with the new details',
  list.total === 2 && list.rows.every((r) => r.membership_type === 'member' && 'residence' in r && 'deaconess' in r && 'department' in r))
const grace = (await A('admin_save_deaconess', { p_name: 'Deaconess Grace' })).id
const ruth = (await A('admin_save_deaconess', { p_name: 'Deaconess Ruth' })).id
const edit = await A('admin_update_person', { p_id: m1.id, p_full_name: 'Esther Wambui Kamau', p_phone: '0702499324', p_department: 'Choir',
  p_residence: 'Kasarani', p_deaconess_id: grace, p_membership_type: 'member' })
check('residence and deaconess can be saved on an existing member', edit.ok === true, JSON.stringify(edit))
check('...and found by the deaconess filter',
  (await A('admin_list_people', { p_kind: 'member', p_deaconess_id: grace })).rows.length === 1)
const newOne = await A('admin_create_member', { p_full_name: 'Naomi New', p_phone: '0766 100 200', p_membership_type: 'incoming_commitment', p_department: 'Ushers' })
check('a new person can join as Incoming Commitment Class', newOne.ok === true)
const vera = (await q(`select id from public.people where full_name = 'Vera Visiting'`))[0].id
const conv = await A('admin_convert_visitor', { p_id: vera, p_full_name: 'Vera Visiting', p_phone: '0722000001', p_membership_type: 'in_commitment', p_deaconess_id: ruth })
check('a migrated visitor can be converted into In Commitment Class', conv.ok === true && conv.registrations_kept === 1, JSON.stringify(conv))
check('the old function signatures are gone (no ambiguous overloads)',
  (await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('admin_create_member', 'admin_update_person', 'admin_convert_visitor', 'admin_list_people')`))[0].n === 4)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
