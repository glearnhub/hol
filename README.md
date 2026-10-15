# Handmaidens of the Lord: event registration and attendance

A mobile-first web application for event organisers: public event
listing and registration, QR-code check-in by volunteers who need **no login**,
and an administrator area with attendance reports.

* **Front end:** plain HTML, CSS and ES-module JavaScript (no framework, no build step).
* **Back end:** Supabase (PostgreSQL, Auth, Storage). All business rules live in the
  database; there is no separate server.
* **Libraries (CDN):** `supabase-js`, `qrcode` (QR generation), `html5-qrcode`
  (QR scanning), `Chart.js` (dashboard chart).

## Contents

1. [How it works](#how-it-works)
2. [Setup](#setup)
3. [Security model](#security-model)
4. [Volunteer check-in](#volunteer-check-in)
5. [Reports and exports](#reports-and-exports)
6. [Project structure](#project-structure)
7. [Testing](#testing)
8. [Deployment](#deployment)
9. [Known limits and choices](#known-limits-and-choices)

## How it works

| Who | Signs in? | What they can do |
|---|---|---|
| Public participant | No | Browse published events, register, get a reference and QR code |
| Administrator | Yes (Supabase Auth, email + password) | Manage events, posters, registrations, attendance, reports, volunteer links |
| Volunteer | No (uses a secret event link) | Scan QR codes or search by name/phone and mark people present, for **one event only** |

The website never talks to the registration tables directly. Registration, check-in
and every administrator action go through `SECURITY DEFINER` database functions that
validate input, scope access, rate-limit and write an audit trail.

## Setup

### 1. Create a Supabase project

Create a project at <https://supabase.com> (the free plan is enough).

### 2. Run the SQL (in this order)

Open **SQL Editor → New query** and run each file completely:

1. `sql/schema.sql`: tables, constraints, indexes, triggers
2. `sql/functions.sql`: all functions and the public event view
3. `sql/policies.sql`: grants, Row Level Security, the poster bucket

The scripts are idempotent. If you ever re-run `functions.sql`, run `policies.sql`
again afterwards so grants are reapplied.

### 3. Create your first administrator

Roles can only be granted by someone with SQL access, never from the website.

1. **Authentication → Users → Add user**, enter an email and password, and tick
   *Auto Confirm User*.
2. In the SQL Editor run (with that email):

```sql
insert into public.admin_roles (user_id)
select id from auth.users where email = 'ADMIN-EMAIL-HERE';
```

Repeat for each additional administrator. Turn **off** public sign-ups under
**Authentication → Providers → Email → Allow new users to sign up** (administrators
are created manually, and there is no public registration page).

### 4. Configure the front end

Edit `js/config.js`:

```js
export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co'
export const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY'   // Project Settings → API
```

The anon (publishable) key is meant to be public. **Never** put the `service_role`
key in any file of this project. `SITE.name` in the same file sets the site name.
`.env.example` lists the same values for reference.

### 5. Open the site

Serve the folder over HTTP(S) (any static host; locally `php -S localhost:8000`
or `npx serve`). Camera scanning requires **HTTPS** (or `localhost`).

## Security model

Anonymous visitors have **no direct access to any table**. They can read one view
and call a short list of functions.

| Object | Anonymous | Signed-in non-admin | Administrator |
|---|---|---|---|
| `public_events` view (published events + live counts) | read | read | read |
| `events` | none | none | read, create, update (specific columns), no delete |
| `registrations` | none | none | read only |
| `attendance` | none | none | read only |
| `volunteer_access` | none | none | read, **without** the token hash column |
| `admin_roles` | none | own row only | own row only |
| `audit_log` | none | none | read only |
| Poster storage | published events' posters only | same | read all, upload, replace, delete |

How the policies work, in plain words:

* **`is_admin()`** is true only when your signed-in user id exists in `admin_roles`.
  Every administrator policy and function checks it on the server.
* **No insert/update/delete policy on `admin_roles`**, so no client can grant roles.
* **Registrations and attendance have no write policy.** They are written only by
  functions: `register_participant`, `volunteer_check_in*`, `admin_set_attendance`,
  `admin_cancel_registration`.
* **Capacity is atomic.** `register_participant` locks the event row (`FOR UPDATE`),
  counts active registrations and inserts inside one transaction, so simultaneous
  registrations can never exceed capacity.
* **Duplicates** are prevented by a unique index on `(event_id, lower(email))`
  for active registrations. A cancelled registration frees that email.
* **Attendance is one row per registration**, enforced by a unique key, so two
  volunteers scanning the same person at once still produce a single record.
* **Secrets are stored hashed.** Participant QR tokens and volunteer link tokens are
  random (about 244 bits); only their SHA-256 hash is stored.
* **Storage:** the `event-posters` bucket is private, limited to 2 MB and
  JPEG/PNG/WebP. Visitors get short-lived signed links, and only for posters that
  belong to a published event.
* **Rate limits** slow down registration spam and token guessing (see below).

## Mobile support

The whole site is designed phone-first and was audited at 320, 360 and 390 px wide:

* no horizontal scrolling on any page;
* every button, link and field is at least 44 px tall (inputs are 16 px so iPhones
  do not zoom in on focus);
* admin tables turn into stacked cards on phones, and the event form opens full-screen;
* the admin menu slides in and closes when you tap elsewhere;
* content respects phone notches and rounded corners (`viewport-fit=cover`);
* the volunteer check-in page works one-handed, with a large Mark Present button.

Camera scanning needs HTTPS and the user's permission to use the camera.

## Volunteer check-in

An administrator opens **Events → Check-in links**, gives the link a label (for
example "Main door") and a validity period, and shares the link or QR code. The
secret token sits after the `#` in the address, so it is never sent to a server or
written to access logs.

A volunteer's link:

* works for **one event** and cannot see or touch anything else;
* cannot create or edit events, export lists or view registrations;
* can be **revoked** or **regenerated** at any time, and expires automatically;
* is separate from participants' QR codes (two different credentials).

Check-in methods:

1. **QR scan:** the camera reads the participant's QR code (an opaque token only,
   with no name, phone or email inside).
2. **Search by name or phone:** the volunteer sees only a name and a masked phone
   hint (`••• ••• 456`), confirms the person, then taps **Mark Present**.
3. **Manual code:** typing the reference printed under the QR (for example
   `HOL-1A2B3C4D`) works when the camera is unavailable.

Check-in is accepted from one day before the event until one day after, in
Nairobi time. Duplicate check-ins report "Already checked in" and create no new
record.

## Reports and exports

* **Dashboard:** total and upcoming events, registrations, attendees, absentees
  (completed events only), a chart, and recent events.
* **Registrations page:** search by name, email, phone or church; filter by
  present, not checked in, absent (after the event) or cancelled; sort; paginate;
  mark present or cancel a registration.
* **Report (Reports page):** pick an event and get a one-page attendance report
  headed by the Handmaidens of the Lord logo and the event's name, date and venue.
  It lists only the people registered for that event, with a **green tick** for
  attended and a **red cross** for did not attend. Cancelled registrations are not
  listed. While an event is still running, a red cross means "not checked in so far".
* **Export:** the report downloads as CSV (UTF-8 with BOM, opens correctly in Excel,
  formula-safe), or use **Print / save as PDF** from the browser's print dialog.

## Project structure

```
index.html  events.html  event-details.html  register.html  confirmation.html
admin.html  admin-dashboard.html  manage-events.html
event-registrations.html  reports.html  check-in.html
css/    styles.css  admin.css  check-in.css
js/     config.js  supabase-client.js  ui.js  layout.js  posters.js
        public-events.js  event-details.js  registration.js  confirmation.js
        admin-auth.js  admin-common.js  admin-dashboard.js  manage-events.js
        event-registrations.js  reports.js  check-in.js
sql/    schema.sql  functions.sql  policies.sql
tests/  db.test.mjs (database tests)   dev-server.mjs (offline test server)
```

There is no `supabase/functions` folder: the secure workflows are PostgreSQL
functions, so no Edge Function deployment is needed.

## Testing

### Automated database tests (113 checks)

Runs all three SQL files against an in-memory PostgreSQL (PGlite) as the real
`anon` and `authenticated` roles:

```bash
cd tests
npm install
npm test
```

They cover public access limits, validation, duplicates, capacity, token secrecy,
volunteer isolation between events, expiry/revocation/regeneration, token-guessing
lockout, role escalation attempts, report arithmetic, absence rules and poster
visibility.

### Offline click-through

```bash
cd tests
node dev-server.mjs          # then open http://localhost:8099/
```

Serves the real site against the real SQL with a fake Auth/Storage layer.
Administrator login there is `admin@example.com` / `test-password`; the volunteer
link is printed in the terminal.

### Manual checklist (against your real Supabase project)

| # | Check | Expected |
|---|---|---|
| 1 | Open the home page signed out | Only published events appear |
| 2 | Log in, create an event, save as draft | Not visible publicly |
| 3 | Publish it | Appears on the public list |
| 4 | Upload a poster (try a PDF, then a 5 MB image) | Wrong type and size are refused; a valid image shows |
| 5 | Register a participant | Confirmation page with reference and QR code |
| 6 | Submit bad email / empty fields | Clear field errors |
| 7 | Register the same email again | "already registered" |
| 8 | Set capacity to 2, register a third person | "fully booked" |
| 9 | Open the QR in a QR reader | Only a long hex string (no personal data) |
| 10 | Create a check-in link, open it on a phone, scan the QR | "Checked in", count increases |
| 11 | Scan the same QR again | "Already checked in" |
| 12 | Search by part of a name, then a phone number | Match shows name and masked phone only |
| 13 | Try a link for event A against a participant of event B | Refused |
| 14 | Revoke the link and reload the check-in page | "link has been revoked" |
| 15 | Log out, visit `admin-dashboard.html` | Redirected to login |
| 16 | Log in with a non-admin Supabase user | "does not have administrator access" |
| 17 | Open Reports and pick an event | Logo and event details on top, then the registered people with ticks and crosses |
| 18 | Export CSV and open in Excel | Accents and phone numbers are intact; Attendance reads Attended / Did not attend |
| 19 | Use the site on a phone | No horizontal scrolling, forms are usable |

Features are marked verified only for what the automated tests and the offline
click-through cover (everything above except steps that need a real camera, a real
Supabase project, Excel and a real phone). Please run the manual checklist once
after deployment.

## Deployment

The site is static, so any static host works.

* **Vercel / Netlify / Cloudflare Pages:** import the repository, framework
  "Other", no build command, output directory = project root. Do **not** deploy the
  `tests/` or `sql/` folders publicly if your host allows excluding them (they
  contain nothing secret, but they are not needed).
* **cPanel (hostAfrica, etc.):** upload the project files to `public_html`
  (keeping folders), or zip them with forward-slash paths (see note below).
  Serve over HTTPS so camera scanning works.

After deploying, add your site URL under **Supabase → Authentication → URL
Configuration**.

> Windows note: PowerShell's `Compress-Archive` can create zips with backslash
> paths that Linux extracts as flat files. Use File Explorer's "Send to →
> Compressed folder", 7-Zip, or an FTP client instead.

## Known limits and choices

* **Time zone:** event times are interpreted as Africa/Nairobi. Change
  `private.event_tz()` in `sql/functions.sql` for another zone.
* **Client address for rate limits** comes from request headers that a determined
  attacker could vary. The limits reduce casual abuse and token guessing; they are
  not a substitute for the token entropy that actually protects access.
* **No emails are sent** (confirmations are shown on screen and can be saved or
  printed). Adding email would need an Edge Function or a mail service.
* **Duplicate identity policy:** one active registration per email per event. The
  same phone number may be used by family members with different emails.
* **Events are cancelled, never deleted,** once they exist (no delete grant), so
  registration history is preserved.
* **PDF reports** use the browser's "Save as PDF" rather than a bundled PDF library.
* **Camera scanning** needs HTTPS (or localhost) and the user's permission; the
  search and manual-code methods work without a camera.
