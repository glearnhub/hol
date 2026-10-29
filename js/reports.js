// Event report: who attended (members and visitors apart), who registered but did not
// come, and the full registration list with a tick or a cross for each person.
// Administrators and event managers can open it; managers see partly hidden phone numbers.
import { supabase } from './supabase-client.js'
import { requireAdmin } from './admin-auth.js'
import { callRpc, errorText, CATEGORIES, VISIBILITY } from './admin-common.js'
import { fetchAllRegistrations } from './event-registrations.js'
import {
  el, $, setChildren, param, isUuid, formatDate, formatDateTime, notice, toast, toCsv, downloadFile, slug,
  formatSchedule,
} from './ui.js'

let current = null // { report, attendance, participants }

const attended = (p) => Boolean(p.checked_in_at)

function mark(p) {
  return attended(p)
    ? el('span', { class: 'mark mark-yes', role: 'img', 'aria-label': 'Attended', title: 'Attended' }, '✓')
    : el('span', { class: 'mark mark-no', role: 'img', 'aria-label': 'Did not attend', title: 'Did not attend' }, '✗')
}

function statBox(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label))
}

function section(title, hint, content) {
  return el('section', { class: 'report-section' }, el('h3', {}, title), hint ? el('p', { class: 'muted' }, hint) : null, content)
}

function peopleTable(headers, rows, empty) {
  if (!rows.length) return el('p', { class: 'muted' }, empty)
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'data report-table' },
      el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows)
    )
  )
}

function renderReport() {
  const { report: r, attendance: a, participants } = current
  const host = $('#report')
  const t = a.totals
  const ev = a.event
  const finished = ev.ended

  const memberRows = a.attended_members.map((m, i) =>
    el(
      'tr',
      {},
      el('td', { class: 'num' }, String(i + 1)),
      el('td', {}, m.label),
      el('td', {}, m.full_name),
      el('td', {}, m.phone),
      el('td', {}, formatDateTime(m.checked_in_at)),
      el('td', {}, m.recorded_by || '—')
    )
  )
  const visitorRows = a.attended_visitors.map((v, i) =>
    el(
      'tr',
      {},
      el('td', { class: 'num' }, String(i + 1)),
      el('td', {}, v.label),
      el('td', {}, v.full_name, v.now_member ? el('span', { class: 'badge badge-success', title: 'Became a member after this event' }, 'Now a member') : null),
      el('td', {}, v.phone),
      el('td', {}, formatDateTime(v.checked_in_at)),
      el('td', {}, v.recorded_by || '—')
    )
  )
  const missed = [
    ...a.registered_members_not_attended.map((p) => ({ ...p, type: 'Member' })),
    ...a.registered_visitors_not_attended.map((p) => ({ ...p, type: 'Visitor' })),
  ]
  const missedRows = missed.map((p, i) =>
    el('tr', {}, el('td', { class: 'num' }, String(i + 1)), el('td', {}, p.label), el('td', {}, p.full_name), el('td', {}, p.type), el('td', {}, p.phone))
  )

  const regRows = participants.map((p, i) =>
    el(
      'tr',
      {},
      el('td', { class: 'num' }, String(i + 1)),
      el('td', {}, p.full_name),
      el('td', {}, p.classification === 'member' ? 'Member' : 'Visitor'),
      el('td', {}, p.phone),
      el('td', {}, p.church_name),
      el('td', { class: 'attendance-cell' }, mark(p))
    )
  )

  setChildren(
    host,
    el(
      'header',
      { class: 'report-head' },
      el('img', { src: 'img/logo.png', alt: 'Handmaidens of the Lord', class: 'report-logo', width: '1064', height: '811' }),
      el(
        'div',
        { class: 'report-title' },
        el('h2', {}, 'Attendance report'),
        el('div', { class: 'report-event' }, ev.name),
        el('div', { class: 'muted' }, `${formatSchedule(ev)}`),
        el('div', { class: 'muted' }, `${ev.venue} · ${CATEGORIES[ev.category] || 'General'} · ${(VISIBILITY[ev.visibility] || VISIBILITY.public).label} event`),
        el('div', { class: 'muted report-generated' }, `Generated ${new Date().toLocaleString()}`)
      )
    ),
    finished
      ? null
      : el('div', { class: 'notice notice-info no-print' }, 'This event has not finished yet. The figures show who has been checked in so far.'),
    !ev.attendance_enabled ? el('div', { class: 'notice notice-warning no-print' }, 'Attendance recording is switched off for this event.') : null,
    el(
      'div',
      { class: 'stats' },
      statBox(t.unique_attendees, 'Attended (everyone)'),
      statBox(t.attended_members, 'Members who attended'),
      statBox(t.attended_visitors, 'Visitors who attended'),
      statBox(t.registered, 'Registered'),
      statBox(t.attendance_percentage === null ? '—' : `${t.attendance_percentage}%`, 'Registered who attended'),
      statBox(t.attended_without_registering, 'Attended without registering')
    ),
    section(
      `Members who attended (${t.attended_members})`,
      'Registered members who were marked present.',
      peopleTable(['No.', 'ID', 'Name', 'Phone', 'Checked in', 'Recorded by'], memberRows, 'No members have been marked present.')
    ),
    section(
      `Visitors who attended (${t.attended_visitors})`,
      'Listed as visitors because that is what they were at this event, even if they have become members since.',
      peopleTable(['No.', 'ID', 'Name', 'Phone', 'Checked in', 'Recorded by'], visitorRows, 'No visitors have been marked present.')
    ),
    section(
      finished ? `Registered but did not attend (${missed.length})` : `Registered, not present yet (${missed.length})`,
      'Only people who registered for this event are listed. Members who did not register are not counted as absent.',
      peopleTable(['No.', 'ID', 'Name', 'Type', 'Phone'], missedRows, finished ? 'Everyone who registered attended.' : 'Everyone who registered is present.')
    ),
    section(
      `Registration list (${participants.length})`,
      null,
      el(
        'div',
        {},
        el(
          'div',
          { class: 'report-legend' },
          el('span', {}, el('span', { class: 'mark mark-yes' }, '✓'), ' Attended'),
          el('span', {}, el('span', { class: 'mark mark-no' }, '✗'), ' Did not attend')
        ),
        peopleTable(['No.', 'Full name', 'Type', 'Phone', 'Church', 'Attendance'], regRows, 'Nobody has registered for this event yet.')
      )
    )
  )
}

async function showEvent(id) {
  const host = $('#report')
  host.replaceChildren(el('p', { class: 'muted' }, 'Loading report…'))
  try {
    const [report, attendance, participants] = await Promise.all([
      callRpc('admin_event_report', { p_event_id: id }),
      callRpc('admin_event_attendance_report', { p_event_id: id }),
      fetchAllRegistrations(id, { filter: 'all', sort: 'name_asc' }),
    ])
    current = { report: report.report, attendance, participants }
    renderReport()
    const url = new URL(window.location.href)
    url.searchParams.set('id', id)
    window.history.replaceState(null, '', url)
  } catch (e) {
    notice(host, errorText(e), 'error')
  }
}

// One CSV with every group, so the file matches the report on screen.
function exportAttendance() {
  if (!current) return
  const a = current.attendance
  const rows = [
    ...a.attended_members.map((p) => ({ group: 'Attended: member', ...p })),
    ...a.attended_visitors.map((p) => ({ group: 'Attended: visitor', ...p })),
    ...a.registered_members_not_attended.map((p) => ({ group: 'Registered, did not attend: member', ...p })),
    ...a.registered_visitors_not_attended.map((p) => ({ group: 'Registered, did not attend: visitor', ...p })),
  ]
  const columns = [
    { header: 'Group', value: (p) => p.group },
    { header: 'ID', value: (p) => p.label },
    { header: 'Full name', value: (p) => p.full_name },
    { header: 'Phone', value: (p) => p.phone },
    { header: 'Checked in at', value: (p) => (p.checked_in_at ? formatDateTime(p.checked_in_at) : '') },
    { header: 'Recorded by', value: (p) => p.recorded_by || '' },
    { header: 'Registered before attending', value: (p) => (p.checked_in_at ? (p.registered ? 'Yes' : 'No') : '') },
    { header: 'Now a member', value: (p) => (p.now_member ? 'Yes' : '') },
  ]
  downloadFile(`${slug(a.event.name)}-attendance.csv`, toCsv(columns, rows))
  toast('Attendance exported')
}

function exportRegistrations() {
  if (!current) return
  // toCsv receives only the row, so the running number is attached to each row.
  const rows = current.participants.map((p, i) => ({ ...p, rowNumber: i + 1 }))
  const columns = [
    { header: 'No.', value: (p) => p.rowNumber },
    { header: 'Full name', value: (p) => p.full_name },
    { header: 'Type', value: (p) => (p.classification === 'member' ? 'Member' : 'Visitor') },
    { header: 'Phone', value: (p) => p.phone },
    { header: 'Church', value: (p) => p.church_name },
    { header: 'Attendance', value: (p) => (attended(p) ? 'Attended' : 'Did not attend') },
  ]
  downloadFile(`${slug(current.report.name)}-registrations.csv`, toCsv(columns, rows))
  toast('Registration list exported')
}

export async function initReports() {
  const session = await requireAdmin('reports', { roles: ['admin', 'manager'] })
  if (!session) return

  const status = $('#status')
  const { data: events, error } = await supabase
    .from('events')
    .select('id, name, event_date')
    .order('event_date', { ascending: false })
    .order('start_time', { ascending: false })

  if (error) {
    notice(status, errorText(error), 'error')
    return
  }
  if (!events.length) {
    notice(status, 'There are no events to report on yet.', 'info')
    $('#report').classList.add('hidden')
    return
  }

  const select = $('#event-select')
  select.replaceChildren(
    ...events.map((e) => el('option', { value: e.id }, `${e.name} (${formatDate(String(e.event_date).slice(0, 10))})`))
  )
  const wanted = param('id')
  if (isUuid(wanted) && events.some((e) => e.id === wanted)) select.value = wanted
  select.addEventListener('change', () => showEvent(select.value))

  $('#print').addEventListener('click', () => window.print())
  $('#export').addEventListener('click', exportAttendance)
  $('#export-registrations').addEventListener('click', exportRegistrations)

  await showEvent(select.value)
}
