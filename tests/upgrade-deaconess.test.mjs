// Upgrade test for the deaconess list. It builds the database as the previous version made it
// (the deaconess typed as free text on each person), fills it, applies the current SQL and checks
// that every distinct name becomes an entry in the list and the members stay linked to it.
//
// The previous SQL is read from git (commit OLD below).
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const OLD = '43819f1' // the version that kept the deaconess as typed text
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

console.log(`Building the previous version (${OLD}) ...`)
await db.exec(oldSql('schema.sql'))
await db.exec(oldSql('functions.sql'))
await db.exec(oldSql('policies.sql'))

const adminId = '11111111-1111-1111-1111-111111111111'
await db.exec(`
  insert into auth.users (id, email) values ('${adminId}', 'admin@example.com');
  insert into public.admin_roles (user_id) values ('${adminId}');
`)
const A = (fn, args) => as('authenticated', () => rpc(fn, args), { uid: adminId })

// The same deaconess typed three ways, another one, and a member with none.
const a = await A('admin_create_member', { p_full_name: 'Member One', p_phone: '0711 000 001', p_deaconess: 'Deaconess Grace' })
const b = await A('admin_create_member', { p_full_name: 'Member Two', p_phone: '0711 000 002', p_deaconess: '  deaconess GRACE ' })
const c = await A('admin_create_member', { p_full_name: 'Member Three', p_phone: '0711 000 003', p_deaconess: 'Deaconess Ruth' })
const d = await A('admin_create_member', { p_full_name: 'Member Four', p_phone: '0711 000 004' })
console.log('Previous version ready:', JSON.stringify({ members: 4 }))

console.log('\nUpgrading with the current sql/*.sql (twice) ...')
for (let i = 0; i < 2; i++) {
  await db.exec(newSql('schema.sql'))
  await db.exec(newSql('functions.sql'))
  await db.exec(newSql('policies.sql'))
}

console.log('\nUpgrade checks')
const q = async (text, params) => (await db.query(text, params)).rows
const cols = (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'people'`)).map((r) => r.column_name)
check('the text column is replaced by a link to the list', !cols.includes('deaconess') && cols.includes('deaconess_id'))
const list = await A('admin_list_deaconesses', {})
check('each distinct name became one entry (spelling and letter case merged)',
  list.rows.length === 2 && list.rows.some((r) => r.name === 'Deaconess Grace') && list.rows.some((r) => r.name === 'Deaconess Ruth'), JSON.stringify(list.rows))
check('both people with her are linked to her', list.rows.find((r) => r.name === 'Deaconess Grace').members === 2)
check('Ruth keeps her member and the member without a deaconess stays without',
  list.rows.find((r) => r.name === 'Deaconess Ruth').members === 1
  && (await q(`select deaconess_id from public.people where id = $1`, [d.id]))[0].deaconess_id === null)
const people = await A('admin_list_people', { p_kind: 'member' })
check('the directory shows the deaconess names', people.rows.find((r) => r.id === a.id).deaconess === 'Deaconess Grace' && people.rows.find((r) => r.id === c.id).deaconess === 'Deaconess Ruth')
check('nothing else changed', people.total === 4)
const grace = list.rows.find((r) => r.name === 'Deaconess Grace').id
check('the list can be used straight away for new members',
  (await A('admin_create_member', { p_full_name: 'Member Five', p_phone: '0711 000 005', p_deaconess_id: grace })).ok === true)
check('the old function signatures are gone (no ambiguous overloads)',
  (await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('admin_create_member', 'admin_update_person', 'admin_convert_visitor', 'admin_list_people')`))[0].n === 4)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
