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
* **Duplicates** are prevented per event by e-mail (case-insensitive) **and** by phone
  number. Phone numbers are normalised first, so `0702499324`, `702499324`,
  `254702499324` and `+254 702 499 324` count as the same number. A cancelled
  registration frees both the email and the phone.
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
3. **Scan from a photo:** takes a picture of the QR code with the phone's camera app
   and reads it. This works even where the live camera is blocked.
4. **Manual code:** typing the reference printed under the QR (for example
   `HOL-1A2B3C4D`) works when the camera is unavailable.

### If the scanner will not start

* **Opened from WhatsApp or another app?** Those apps' built-in browsers usually
  block the camera. Tap the menu and choose "Open in Chrome" or "Open in browser"
  (the check-in page has a "Copy this link" button for this), or use
  **Scan from a photo**.
* **"Camera access is blocked":** allow Camera for the site in the browser (lock or
  camera icon in the address bar), then press **Start camera** again.
* **"Camera is being used by another app":** close the other app and retry.
* The page must be served over **HTTPS** for the live camera to work.

Check-in is accepted from **seven days before** the event starts (so volunteers can
rehearse) until **one day after** it ends, in Nairobi time. Outside that window the
check-in screen says exactly when it opens and closes. Duplicate check-ins report "Already checked in" and create no new
record.

**Overnight events:** each event has an optional **End date** and **End time**. Leave the
end date empty for a same-day event; for a night vigil (a "kesha") that starts on Friday at
8 pm and finishes on Saturday at 5 am, set the end date to Saturday and the end time to
5:00 AM. The event stays open for registration and check-in until that end moment (plus the
one-day grace period above). If your database was created before this feature, re-run
`sql/schema.sql`, then `sql/functions.sql`, then `sql/policies.sql`.

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
| 7 | Register the same email again, or the same phone written another way (`0702…` vs `+254702…`) | "already registered" |
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
* **Duplicate identity policy:** one active registration per email **and** per phone
  number per event. Family members sharing one phone must register with their own
  numbers, or the organisers can register them at the door.
* **Events are cancelled, never deleted,** once they exist (no delete grant), so
  registration history is preserved.
* **PDF reports** use the browser's "Save as PDF" rather than a bundled PDF library.
* **Camera scanning** needs HTTPS (or localhost) and the user's permission; the
  search and manual-code methods work without a camera.

## Registration form: consent and church

* The form needs a ticked **consent** box before it can be submitted. The database also
  refuses a registration without consent and stores when it was given (`consented_at`).
* **Church** is a drop-down. **Chrisco Upperroom Fellowship** is listed; choosing **Other**
  opens a box for the participant to type their church. To add more churches to the list,
  add an `<option>` to the church `<select>` in `register.html`.
* If you already ran the SQL before this change, re-run `sql/schema.sql`, `sql/functions.sql`
  and `sql/policies.sql` in that order (the registration function gained a consent argument).

## Thank-you emails to attendees

On an event's **Registrations** page, **Thank-you email** lists the email addresses of
everyone who was checked in (not just registered). Use **Copy emails**, paste them into the
**BCC** box of your own email, and use the suggested subject and message (also copyable).
Tick *Use semicolons* if your email program (Outlook) needs `;` between addresses. The site
does not send emails itself.

## Link previews (thumbnail)

When a page link is shared on WhatsApp, Facebook, X or similar, the preview shows the
Handmaidens of the Lord logo (`img/og-image.png`, 1200×630). The tags are in the `<head>`
of each public page and use the absolute address `https://hol-lake.vercel.app`. If you
move the site to a custom domain, replace that address in the `og:` and `twitter:` meta
tags of `index.html`, `events.html`, `event-details.html`, `register.html`,
`confirmation.html` and `check-in.html`. Chat apps cache previews, so a link shared
before this change may keep its old preview for a while.

## Email is optional

The email field on the registration form is optional; the phone number is the required contact.
Duplicate checks still use the phone number (and the email, when one is given). The Thank-you
email panel lists only the attendees who gave an email address and says how many did not.
To apply this to an existing database, re-run `sql/schema.sql` then `sql/functions.sql` and
`sql/policies.sql`.

## Members, visitors and attendance

### The model in one paragraph

Every person is **one record** in `people`, identified by their normalised phone number
(`0712…`, `712…`, `254712…` and `+254 712…` are the same number). A person is a *member* or a
*visitor*; converting a visitor changes that one record, so their registrations and attendance
stay attached. Each registration and each attendance record also remembers what the person
**was at that moment** (`classification`), so a visitor who becomes a member in March still
shows as a visitor in January's report. A registration never counts as attendance: a person
is counted only when an usher (or staff) checks them in. At most one attendance record exists
per person per event.

Display numbers: `M-00012` for a member, `V-00012` for a visitor. The number stays the same
when a visitor is converted.

### Roles

| Role | Can do |
|---|---|
| **Administrator** (`admin_roles.role = 'admin'`) | Everything: events, links, members, visitors, conversion, reports with full phone numbers, annual ranking, corrections |
| **Event manager** (`'manager'`) | See events, record and correct attendance, open event reports. Phone numbers are partly hidden and email addresses are not shown. Cannot create events, manage links, register or convert people, or cancel registrations |
| **Usher** | Anyone holding an event's *attendance link* (no account): search by name or phone, mark people present, register walk-ins (if the link allows it). Sees only a name, a masked phone and member/visitor |
| **Visitor / member** | Registers through the event's registration link (or the website for public events) |

Roles are granted in the SQL editor only:

```sql
insert into public.admin_roles (user_id, role)
select id, 'manager' from auth.users where email = 'MANAGER-EMAIL-HERE';
```

Managers are not limited to particular events (there is no per-event assignment).

### Member details

Besides name, phone, email, gender, church and notes, each person has:

* **Membership type:** *Incoming Commitment Class*, *In Commitment Class*, *Member* or *Visitor*.
  People in either commitment class are members of the directory, so ushers and reports treat
  them as members. Only the type *Visitor* is a visitor. Changing the type of a visitor to a
  member type converts them (their history stays), and setting a member back to *Visitor* moves
  them to the visitors list.
* **Residence:** where they live, for example "Kasarani, Nairobi".
* **Department:** where they serve in church. (This is the field that used to be called
  "ministry"; whatever was typed there is kept.)
* **Deaconess:** the leader assigned to mentor them, chosen from a list. The administrator
  keeps that list under **Deaconesses** (add a name once, edit it, deactivate or remove it);
  when registering or editing a member you just pick from the dropdown, so names are always
  spelled the same way. A deactivated deaconess keeps her current members but is not offered for
  new ones, and one who mentors members cannot be removed until they are moved. Click the member
  count next to a deaconess to see everyone she mentors.

On the Members page you can filter by membership type, department and deaconess (for example
everyone a particular deaconess mentors), search by any of these, sort by department or
deaconess, and export them all to CSV. Departments and residences already in use
are offered as suggestions while typing, so spelling stays consistent.

### Importing members from a CSV file

On the **Members** page, **Import CSV** opens a three-step screen:

1. **Download the template** (`members-import-template.csv`). It has the columns Full name, Phone,
   Alternative phone, Email, Gender, Membership type, Membership date, Residence, Department,
   Deaconess, Church and Notes, and two sample rows that are ignored. Fill it in with Excel or
   Google Sheets and save it as CSV (comma, semicolon or tab separated all work).
2. **Choose the file.** It is checked at once and *nothing is saved*: every row is marked *will be
   added*, *skipped* or *error*, with the reason and its line number. People whose phone number is
   already registered are never added twice (the message says who has it, and points visitors to the
   Visitors page); the same number twice in one file is caught; a similar name is held back for a
   look unless you tick "import similar names anyway"; an unknown deaconess is an error unless you
   tick "add deaconesses that are not in the list yet". Dates can be `2024-03-17` or `17/03/2024`.
3. **Import.** The rows that passed are saved in one go and the page updates. You can download a
   CSV of the rows that were not added, fix them, and import that file.

You can choose the file as a CSV or as an Excel workbook (`.xlsx`; the first sheet is used, and
phone numbers that Excel stored without their leading zero are understood).

**People who are already visitors become members.** Each row is matched against everyone on
record by **phone number or email**. A visitor who matches is turned into a member in place: it is
the same record, so their registrations and attendance stay, past events still show them as a
visitor, and they keep their member number. The details in your file are added; cells you leave
blank keep what was there, and if the file has a different phone number the old one is kept as the
alternative number. A match on **both** phone and email is certain. A match on only one of them
needs a name that agrees; if the name is very different the row is held back with an explanation
(tick "Make a visitor a member even if the name in the file looks different" to go ahead). A row
whose phone belongs to one person and whose email belongs to another is never guessed at. People
who are already **members** are never changed or added twice.

Up to 2000 people per file. Only administrators can import.

### Events and their two links

Every event has a **category**, a **visibility** (public, private or internal), and switches
for **attendance** and **registration**. Private and internal events are never listed on the
website. When an event is created it gets:

* a **registration link** (`register.html?t=…`): for visitors and others to register, and the
  only way into a private or internal event. Registering does not mark anyone present;
* an **attendance link** (`check-in.html#…`) for ushers, valid until three days after the event.

Open **Events → Event links** to copy, open, show a QR code for, regenerate or disable them,
and to create more labelled attendance links (with or without permission to register walk-ins).
Regenerating or revoking a link stops the old one immediately. Tokens are long random values,
never database IDs, and the table that holds them cannot be read through the website's API.

### Day to day

1. **Register a member:** *Members → Add member* (choose the membership type; the default is Member). While you type, the page warns about people
   with the same phone number, email or a similar name. The same phone number is refused; a
   similar name can be added after you have looked at the existing record.
2. **Visitors register** through the registration link. A returning visitor is recognised by
   phone number and gets no second profile. A very different name on an existing number is not
   merged: the person is flagged *Needs review*.
3. **At the door** the usher opens the attendance link, searches a name or phone number, and
   taps *Mark Present*. A second tap says *This person has already been marked present for this
   event.* Someone not in the list is registered and marked present in one step (name, phone,
   consent).
4. **Convert a visitor:** *Visitors → Convert to member*. Check the details and confirm.
5. **Corrections:** *Events → Attendance* has a search to mark anyone present or remove a
   mistake. Removed records are copied to `attendance_corrections` with who, when and why.
6. **Reports:** *Reports* shows members who attended, visitors who attended, registered people
   who did not come, and the registration list with ✓ / ✗. Export CSV or print to PDF.
7. **Annual attendance:** *Attendance ranking* ranks people by meetings attended in a year.

### Annual ranking rules

* A meeting counts when it is **published or completed**, has **attendance recording on**, and
  its **date** falls in the selected year. Drafts and cancelled events never count.
* Each person counts **once per meeting**. Registering without being checked in counts for nothing.
* Ties share a rank and the next rank skips ahead (1, 2, 2, 4).
* *Members* means people who are members **now**, with all their attendance in the year. Event
  reports, in contrast, use what each person was **at that event**.
* Participation rate = member attendances ÷ (meetings held × active members).
* "Meetings held" counts eligible meetings dated today or earlier.
* Not implemented: improving / declining attendance, and separate sessions within one event
  (an event is counted once per person).

### Upgrading an existing database

1. **Back up first.** In Supabase: *Database → Backups* (or *Project settings → Database* to
   download a backup). Keep it until you have checked the site.
2. In the SQL editor run, in this order, the whole of: `sql/schema.sql`, `sql/functions.sql`,
   `sql/policies.sql`. All three can be run again safely.
3. If deaconess names were typed in before the list existed, each distinct name becomes an
   entry in the Deaconesses list and its members are linked to it automatically.
   The upgrade links old data automatically: every distinct phone number among the old
   registrations becomes one **visitor**, and old registrations and attendance are attached to
   it. Nothing is deleted, with one tidy-up: if the same phone number was registered twice for one event and both were checked in, the person is counted once (the earliest check-in is kept) and the extra one is copied to `attendance_corrections` with the actor `system:upgrade`. Convert regular people to members on the *Visitors* page. Existing
   events become public events with both links created.
4. Deploy the website code (push to the repository; Vercel deploys it).

**Rollback:** restore the backup from step 1 and redeploy the previous commit. The previous
version of the SQL is `git show 0088ca9:sql/schema.sql` (and `functions.sql`, `policies.sql`).
The upgrade test `tests/migration.test.mjs` builds a database with that version, fills it with
data, applies the new scripts and checks that nothing was lost.

### Tests

`cd tests && npm install && npm test` runs `db.test.mjs` (the database rules, including the
new members, visitors, links, ushers, reports and ranking) and `migration.test.mjs` (the
upgrade). They run against an in-memory PostgreSQL (PGlite), not your live Supabase project.
