// Offline test server for the frontend.
//
// Serves the website AND a tiny stand-in for the Supabase REST API, backed by the
// REAL sql/*.sql files running in PGlite. It lets you click through the public
// registration flow and the volunteer check-in page without a Supabase project.
//
//   cd tests && npm install && node dev-server.mjs
//   open http://localhost:8099/
//
// It also fakes Supabase Auth (log in as admin@example.com / test-password), generic
// table access and Storage, all executed under the real RLS policies, so the
// administrator pages can be exercised too.
import http from 'node:http'
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const PORT = Number(process.env.PORT || 8099)
const sql = (f) => readFileSync(path.join(root, 'sql', f), 'utf8')

// ---- database ---------------------------------------------------------------
const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin;
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
await db.exec(sql('schema.sql'))
await db.exec(sql('functions.sql'))
await db.exec(sql('policies.sql'))

const day = (await db.query(`select ((now() at time zone 'Africa/Nairobi')::date + 1)::text d`)).rows[0].d
const ev = async (name, cap, status = 'published', extra = '') =>
  (await db.query(
    `insert into public.events (name, description, venue, event_date, start_time, end_time, capacity, status)
     values ($1, $2, 'Grace Chapel, Nairobi', $3, '09:00', '16:00', $4, $5) returning id`,
    [name, 'A full day of talks, workshops and networking.\nEveryone is welcome. ' + extra, day, cap, status]
  )).rows[0].id

const conference = await ev("Women's Conference 2026", 5)
const small = await ev('Prayer Breakfast', 2)
await ev('Internal Planning (draft)', 10, 'draft')

const adminUser = (await db.query(`insert into auth.users (email) values ('admin@example.com') returning id`)).rows[0].id
await db.exec(`insert into public.admin_roles (user_id) values ('${adminUser}')`)
const memberUser = (await db.query(`insert into auth.users (email) values ('member@example.com') returning id`)).rows[0].id

// Fake sessions: token -> user. Credentials: email / 'test-password'.
const USERS = {
  'admin@example.com': { id: adminUser, token: 'admin-test-token' },
  'member@example.com': { id: memberUser, token: 'member-test-token' },
}
const byToken = (t) => Object.entries(USERS).find(([, u]) => u.token === t)
const fakeJwt = (email, u) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: u.id, email, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.${u.token}`
}
const sessionFor = (email) => {
  const u = USERS[email]
  return {
    access_token: fakeJwt(email, u), token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-' + u.token,
    user: { id: u.id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  }
}
const files = new Map() // storage object bytes
await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [adminUser])
await db.exec('set role authenticated')
const link = (await db.query(
  `select public.admin_create_volunteer_link($1, 'Main door', now() + interval '3 days') as r`, [conference]
)).rows[0].r
await db.exec('reset role')
await db.query(`select set_config('request.jwt.claim.sub', '', false)`)

writeFileSync(path.join(here, '.dev-info.json'), JSON.stringify({
  conference, small, volunteerToken: link.token, port: PORT,
}, null, 2))

// ---- tiny Supabase stand-in (REST, Auth, Storage) -----------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }
const TABLES = new Set(['public_events', 'events', 'registrations', 'attendance', 'volunteer_access', 'admin_roles', 'audit_log'])
const POSTER_TYPES = ['image/jpeg', 'image/png', 'image/webp']

function send(res, status, body, headers = {}) {
  const text = body === undefined || body === '' ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
    ...headers,
  })
  res.end(text)
}

function dbError(res, e) {
  const code = e.code || 'XX000'
  const status = code === '42501' ? 403 : code === '23505' ? 409 : 400
  return send(res, status, { code, message: e.message, details: e.detail || null, hint: e.hint || null })
}

// Runs fn as the database role implied by the request's bearer token.
async function asRequester(req, fn) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  // Fake JWTs carry the test token as their third segment.
  const raw = bearer.includes('.') ? bearer.split('.').pop() : bearer
  const found = byToken(raw)
  const ip = req.headers['x-test-ip'] || req.headers['x-forwarded-for'] || '127.0.0.1'
  await db.query(`select set_config('request.headers', $1, false)`, [JSON.stringify({ 'x-forwarded-for': ip })])
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [found ? found[1].id : ''])
  await db.exec(found ? 'set role authenticated' : 'set role anon')
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}

async function readRaw(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const raw = (await readRaw(req)).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

const ident = (s) => /^[a-z_][a-z0-9_]*$/.test(s)

// Translates PostgREST-style filters (col=eq.x, col=is.null, col=in.(a,b)) to SQL.
function filtersOf(url) {
  const where = []
  const values = []
  for (const [k, v] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue
    if (!ident(k)) throw new Error(`bad column ${k}`)
    let m
    if ((m = /^eq\.(.*)$/.exec(v))) {
      values.push(m[1])
      where.push(`${k}::text = $${values.length}`)
    } else if (v === 'is.null') {
      where.push(`${k} is null`)
    } else if ((m = /^in\.\((.*)\)$/.exec(v))) {
      const parts = m[1].split(',').map((x) => x.replace(/^"|"$/g, ''))
      const ph = parts.map((p) => (values.push(p), `$${values.length}`))
      where.push(`${k}::text in (${ph.join(',')})`)
    } else {
      throw new Error(`unsupported filter ${k}=${v}`)
    }
  }
  return { where, values }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  try {
    if (req.method === 'OPTIONS') return send(res, 204, '')

    // ---- Auth ---------------------------------------------------------------
    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
      const { email, password } = await readJson(req)
      if (!USERS[email] || password !== 'test-password') {
        return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials', error: 'invalid_grant', error_description: 'Invalid login credentials' })
      }
      return send(res, 200, sessionFor(email))
    }
    if (url.pathname === '/auth/v1/logout') return send(res, 204, '')
    if (url.pathname === '/auth/v1/user') {
      const t = (req.headers.authorization || '').split('.').pop()
      const f = byToken(t)
      return f ? send(res, 200, sessionFor(f[0]).user) : send(res, 401, { msg: 'unauthorized' })
    }

    // ---- RPC ----------------------------------------------------------------
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)
    if (rpc && req.method === 'POST') {
      const args = await readJson(req)
      const keys = Object.keys(args).filter(ident)
      const placeholders = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
      try {
        const out = await asRequester(req, () =>
          db.query(`select public.${rpc[1]}(${placeholders}) as r`, keys.map((k) => args[k]))
        )
        return send(res, 200, out.rows[0].r)
      } catch (e) {
        return dbError(res, e)
      }
    }

    // ---- Tables -------------------------------------------------------------
    const table = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)
    if (table && TABLES.has(table[1])) {
      const name = table[1]
      const accept = req.headers.accept || ''
      const prefer = req.headers.prefer || ''

      try {
        if (req.method === 'GET') {
          const { where, values } = filtersOf(url)
          const sel = url.searchParams.get('select') || '*'
          const cols = /^[a-z_,]+$/.test(sel) ? sel : '*'
          const order = (url.searchParams.getAll('order').join(',') || '')
            .split(',').filter(Boolean).map((o) => o.split('.'))
            .filter(([c]) => ident(c)).map(([c, d]) => `${c} ${d === 'desc' ? 'desc' : 'asc'}`).join(', ')
          const q = `select ${cols} from public.${name}` +
            (where.length ? ` where ${where.join(' and ')}` : '') + (order ? ` order by ${order}` : '')
          const out = await asRequester(req, () => db.query(q, values))
          if (/vnd\.pgrst\.object/.test(accept)) {
            return out.rows.length === 1
              ? send(res, 200, out.rows[0])
              : send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })
          }
          return send(res, 200, out.rows)
        }

        if (req.method === 'POST') {
          const body = await readJson(req)
          const rows = Array.isArray(body) ? body : [body]
          const cols = Object.keys(rows[0]).filter(ident)
          const values = []
          const tuples = rows.map((r) => `(${cols.map((c) => (values.push(r[c] ?? null), `$${values.length}`)).join(',')})`)
          const wantRows = /return=representation/.test(prefer)
          const q = `insert into public.${name} (${cols.join(',')}) values ${tuples.join(',')}${wantRows ? ' returning *' : ''}`
          const out = await asRequester(req, () => db.query(q, values))
          return wantRows ? send(res, 201, out.rows) : send(res, 201, '')
        }

        if (req.method === 'PATCH') {
          const body = await readJson(req)
          const { where, values } = filtersOf(url)
          if (!where.length) return send(res, 400, { message: 'update requires a filter' })
          const cols = Object.keys(body).filter(ident)
          const sets = cols.map((c) => (values.push(body[c] ?? null), `${c} = $${values.length}`))
          const wantRows = /return=representation/.test(prefer)
          const q = `update public.${name} set ${sets.join(', ')} where ${where.join(' and ')}${wantRows ? ' returning *' : ''}`
          const out = await asRequester(req, () => db.query(q, values))
          return wantRows ? send(res, 200, out.rows) : send(res, 204, '')
        }
      } catch (e) {
        return dbError(res, e)
      }
    }

    // ---- Storage ------------------------------------------------------------
    // Upload: POST /storage/v1/object/event-posters/<path>
    const up = url.pathname.match(/^\/storage\/v1\/object\/event-posters\/(.+)$/)
    if (up && ['POST', 'PUT'].includes(req.method)) {
      const name = decodeURIComponent(up[1])
      let bytes = await readRaw(req)
      let type = (req.headers['content-type'] || '').split(';')[0]

      // supabase-js sends File/Blob uploads as multipart/form-data.
      if (type === 'multipart/form-data') {
        const boundary = /boundary=(.+)$/.exec(req.headers['content-type'])[1]
        const text = bytes.toString('latin1')
        const CRLF = String.fromCharCode(13, 10)
        const start = text.indexOf(CRLF + CRLF, text.indexOf('filename=')) + 4
        const head = text.slice(text.indexOf('--' + boundary), start)
        type = (head.split(CRLF).find((l) => /^content-type:/i.test(l)) || '').split(':')[1]?.trim() || ''
        const end = text.indexOf(CRLF + '--' + boundary, start)
        bytes = Buffer.from(text.slice(start, end), 'latin1')
      }
      if (!POSTER_TYPES.includes(type)) return send(res, 415, { message: 'mime type not allowed' })
      if (bytes.length > 2097152) return send(res, 413, { message: 'The object exceeded the maximum allowed size' })
      try {
        await asRequester(req, () =>
          db.query(`insert into storage.objects (bucket_id, name) values ('event-posters', $1)`, [name]))
        files.set(name, { bytes, type })
        return send(res, 200, { Id: crypto.randomUUID(), Key: `event-posters/${name}` })
      } catch (e) {
        return send(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' })
      }
    }

    // Sign: POST /storage/v1/object/sign/event-posters  { paths: [...] }
    if (url.pathname === '/storage/v1/object/sign/event-posters' && req.method === 'POST') {
      const { paths = [] } = await readJson(req)
      const visible = await asRequester(req, () => db.query(`select name from storage.objects where bucket_id = 'event-posters'`))
      const names = new Set(visible.rows.map((r) => r.name))
      return send(res, 200, paths.map((p) =>
        names.has(p) && files.has(p)
          ? { path: p, error: null, signedURL: `/object/sign/event-posters/${p}?token=offline` }
          : { path: p, error: 'Object not found', signedURL: null }
      ))
    }

    // Download a signed object
    const dl = url.pathname.match(/^\/storage\/v1\/object\/sign\/event-posters\/(.+)$/)
    if (dl && req.method === 'GET') {
      const f = files.get(decodeURIComponent(dl[1]))
      if (!f) return send(res, 404, { message: 'not found' })
      res.writeHead(200, { 'Content-Type': f.type })
      return res.end(f.bytes)
    }

    // Delete: DELETE /storage/v1/object/event-posters  { prefixes: [...] }
    if (url.pathname === '/storage/v1/object/event-posters' && req.method === 'DELETE') {
      const { prefixes = [] } = await readJson(req)
      try {
        for (const p of prefixes) {
          await asRequester(req, () => db.query(`delete from storage.objects where bucket_id = 'event-posters' and name = $1`, [p]))
          files.delete(p)
        }
        return send(res, 200, [])
      } catch (e) {
        return dbError(res, e)
      }
    }

    // ---- Test configuration instead of the real js/config.js -------------------
    if (url.pathname === '/js/config.js') {
      const real = readFileSync(path.join(root, 'js', 'config.js'), 'utf8')
      const patched = real
        .replace(/SUPABASE_URL = '[^']*'/, `SUPABASE_URL = 'http://localhost:${PORT}'`)
        .replace(/SUPABASE_ANON_KEY = '[^']*'/, `SUPABASE_ANON_KEY = 'offline-test-key'`)
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      return res.end(patched)
    }

    // ---- Static files ------------------------------------------------------------
    const file = path.join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!file.startsWith(root) || file.includes(`${path.sep}tests${path.sep}`) || file.includes(`${path.sep}sql${path.sep}`)) {
      return send(res, 404, { error: 'not found' })
    }
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      return res.end(readFileSync(file))
    }
    return send(res, 404, { error: 'not found' })
  } catch (e) {
    return send(res, 500, { message: e.message })
  }
})

server.listen(PORT, () => {
  console.log(`Offline test server on http://localhost:${PORT}/`)
  console.log(`Administrator login: admin@example.com / test-password`)
  console.log(`Volunteer link: http://localhost:${PORT}/check-in.html#${link.token}`)
})
