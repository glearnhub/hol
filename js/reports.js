// Attendance reports: all-events overview and a detailed per-event report.
import { requireAdmin } from './admin-auth.js'
import { callRpc, eventStatusBadge, attendanceBadge, errorText } from './admin-common.js'
import { fetchAllRegistrations, PARTICIPANT_COLUMNS } from './event-registrations.js'
import {
  el, $, formatDate, formatTimeRange, notice, toast, toCsv, downloadFile, slug,
} from './ui.js'

let overview = []
let current = null // { report, churches }

function stat(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label))
}

// "Not yet checked in" before the event finishes; "Absent" afterwards.
const missingLabel = (e) => (e.completed ? 'Absent' : 'Not yet checked in')
const missingValue = (e) => (e.completed ? e.absentees : e.not_checked_in)

function renderOverview() {
  const host = $('#overview')
  if (overview.length === 0) {
    host.replaceChildren(el('p', { class: 'muted' }, 'No events to report on yet.'))
    return
  }
  host.replaceChildren(
    el(
      'table',
      { class: 'data' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ...['Event', 'Date', 'Status', 'Capacity', 'Registered', 'Attended', 'Not attended', 'Attendance', 'Spaces left']
            .map((h) => el('th', {}, h))
        )
      ),
      el(
        'tbody',
        {},
        ...overview.map((e) =>
          el(
            'tr',
            {},
            el('td', {}, el('strong', {}, e.name), el('div', { class: 'muted' }, e.venue)),
            el('td', {}, formatDate(e.event_date)),
            el('td', {}, eventStatusBadge(e.status)),
            el('td', {}, String(e.capacity)),
            el('td', {}, String(e.registrations)),
            el('td', {}, String(e.attendees)),
            el('td', {}, `${missingValue(e)} `, el('span', { class: 'muted' }, `(${missingLabel(e)})`)),
            el('td', {}, `${e.attendance_percentage}%`),
            el('td', {}, String(e.remaining_capacity))
          )
        )
      )
    )
  )
}

async function showEvent(id) {
  const detail = $('#detail')
  detail.replaceChildren(el('p', { class: 'muted' }, 'Loading report…'))
  try {
    const [data, participants] = await Promise.all([
      callRpc('admin_event_report', { p_event_id: id }),
      fetchAllRegistrations(id, { filter: 'all', sort: 'name_asc' }),
    ])
    current = { report: data.report, churches: data.churches, participants }
    renderDetail()
  } catch (e) {
    notice(detail, errorText(e), 'error')
  }
}

function renderDetail() {
  const { report: r, churches, participants } = current
  const completed = r.completed

  const churchTable = churches.length
    ? el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Church', 'Registered', 'Attended', 'Attendance'].map((h) => el('th', {}, h)))),
        el(
          'tbody',
          {},
          ...churches.map((c) =>
            el('tr', {}, el('td', {}, c.church_name), el('td', {}, String(c.registered)), el('td', {}, String(c.attended)), el('td', {}, `${c.percentage}%`))
          )
        )
      )
    : el('p', { class: 'muted' }, 'No registrations yet.')

  const list = participants.length
    ? el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Name', 'Phone', 'Church', 'Attendance'].map((h) => el('th', {}, h)))),
        el(
          'tbody',
          {},
          ...participants.map((p) =>
            el('tr', {}, el('td', {}, p.full_name), el('td', {}, p.phone), el('td', {}, p.church_name), el('td', {}, attendanceBadge(p, completed)))
          )
        )
      )
    : el('p', { class: 'muted' }, 'No participants.')

  $('#detail').replaceChildren(
    el('h2', {}, r.name),
    el('p', { class: 'muted' }, `${formatDate(r.event_date)} · ${formatTimeRange(r.start_time, r.end_time)} · ${r.venue}`),
    el('p', { class: 'print-only' }, `Report generated ${new Date().toLocaleString()}`),
    completed
      ? null
      : el(
          'div',
          { class: 'notice notice-info' },
          'This event has not finished yet, so figures are interim. Participants who have not checked in are shown as "Not yet checked in", not absent.'
        ),
    el(
      'div',
      { class: 'stats' },
      stat(r.capacity, 'Capacity'),
      stat(r.registrations, 'Valid registrations'),
      stat(r.attendees, 'Attendees'),
      stat(missingValue(r), missingLabel(r)),
      stat(`${r.attendance_percentage}%`, 'Attendance rate'),
      stat(r.remaining_capacity, 'Remaining capacity')
    ),
    el('h2', {}, 'By church'),
    el('div', { class: 'table-wrap' }, churchTable),
    el('h2', { style: 'margin-top:1.5rem' }, completed ? 'Attendance list' : 'Participants (interim)'),
    el('div', { class: 'table-wrap' }, list)
  )
}

export async function initReports() {
  const session = await requireAdmin('reports')
  if (!session) return

  const status = $('#status')
  try {
    const data = await callRpc('admin_reports_overview')
    overview = data.events || []
  } catch (e) {
    notice(status, errorText(e), 'error')
    return
  }

  renderOverview()

  const select = $('#event-select')
  if (overview.length === 0) {
    $('#detail-panel').classList.add('hidden')
    return
  }
  select.replaceChildren(
    ...overview.map((e) => el('option', { value: e.event_id }, `${e.name} (${formatDate(e.event_date)})`))
  )
  select.addEventListener('change', () => showEvent(select.value))

  $('#print').addEventListener('click', () => window.print())

  $('#export-participants').addEventListener('click', () => {
    if (!current) return
    downloadFile(
      `${slug(current.report.name)}-attendance.csv`,
      toCsv(PARTICIPANT_COLUMNS(current.report.completed), current.participants)
    )
    toast('Participant list exported')
  })

  $('#export-churches').addEventListener('click', () => {
    if (!current) return
    const cols = [
      { header: 'Church', value: (c) => c.church_name },
      { header: 'Registered', value: (c) => c.registered },
      { header: 'Attended', value: (c) => c.attended },
      { header: 'Attendance %', value: (c) => c.percentage },
    ]
    downloadFile(`${slug(current.report.name)}-churches.csv`, toCsv(cols, current.churches))
    toast('Church summary exported')
  })

  await showEvent(select.value)
}
