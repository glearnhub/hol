// Participant list for one event: search, filter, sort, paginate, export, mark present.
import { requireAdmin } from './admin-auth.js'
import { callRpc, attendanceBadge, attendanceLabel, errorText } from './admin-common.js'
import {
  el, $, param, isUuid, formatDate, formatTimeRange, formatDateTime, notice, toast, toCsv, downloadFile,
  debounce, slug,
} from './ui.js'

const PAGE_SIZE = 20
let eventId = null
let ended = false
let report = null
const state = { page: 0, search: '', filter: 'all', sort: 'created_desc', total: 0 }

function statCard(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label))
}

async function loadReport() {
  const data = await callRpc('admin_event_report', { p_event_id: eventId })
  report = data.report
  ended = report.completed
  $('#event-name').textContent = report.name
  $('#event-meta').textContent =
    `${formatDate(report.event_date)} · ${formatTimeRange(report.start_time, report.end_time)} · ${report.venue}`
  document.title = `${report.name} registrations · Handmaidens of the Lord`

  $('#stats').replaceChildren(
    statCard(`${report.registrations} / ${report.capacity}`, 'Registered'),
    statCard(report.attendees, 'Present'),
    statCard(ended ? report.absentees : report.not_checked_in, ended ? 'Absent' : 'Not yet checked in'),
    statCard(`${report.attendance_percentage}%`, 'Attendance'),
    statCard(report.remaining_capacity, 'Spaces left')
  )
}

async function loadPage() {
  const host = $('#table')
  try {
    const data = await callRpc('admin_list_registrations', {
      p_event_id: eventId,
      p_search: state.search,
      p_filter: state.filter,
      p_sort: state.sort,
      p_limit: PAGE_SIZE,
      p_offset: state.page * PAGE_SIZE,
    })
    state.total = data.total
    renderTable(data.rows)
    renderPager()
  } catch (e) {
    notice($('#status'), errorText(e), 'error')
  }
}

function renderTable(rows) {
  const host = $('#table')
  if (rows.length === 0) {
    host.replaceChildren(el('p', { class: 'muted' }, 'No participants match these filters.'))
    return
  }

  host.replaceChildren(
    el(
      'table',
      { class: 'data' },
      el(
        'thead',
        {},
        el('tr', {}, ...['Name', 'Email', 'Phone', 'Church', 'Registered', 'Attendance', 'Checked in', ''].map((h) => el('th', {}, h)))
      ),
      el(
        'tbody',
        {},
        ...rows.map((r) =>
          el(
            'tr',
            {},
            el('td', {}, el('strong', {}, r.full_name), el('div', { class: 'muted' }, r.registration_reference)),
            el('td', {}, r.email),
            el('td', {}, r.phone),
            el('td', {}, r.church_name),
            el('td', {}, formatDateTime(r.created_at)),
            el('td', {}, attendanceBadge(r, ended)),
            el('td', {}, r.checked_in_at ? formatDateTime(r.checked_in_at) : '—'),
            el('td', {}, rowActions(r))
          )
        )
      )
    )
  )
}

function rowActions(r) {
  if (r.status === 'cancelled') return null
  return el(
    'div',
    { class: 'row-actions' },
    r.checked_in_at
      ? el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => setPresent(r, false) }, 'Undo')
      : el('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => setPresent(r, true) }, 'Mark present'),
    el('button', { class: 'btn btn-danger btn-small', type: 'button', onclick: () => cancelRegistration(r) }, 'Cancel')
  )
}

async function setPresent(r, present) {
  try {
    await callRpc('admin_set_attendance', { p_registration_id: r.id, p_present: present })
    toast(present ? `${r.full_name} marked present` : 'Attendance cleared')
    await Promise.all([loadReport(), loadPage()])
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

async function cancelRegistration(r) {
  if (!confirm(`Cancel the registration of ${r.full_name}? Their QR code will stop working and the place is freed.`)) return
  try {
    await callRpc('admin_cancel_registration', { p_registration_id: r.id })
    toast('Registration cancelled')
    await Promise.all([loadReport(), loadPage()])
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

function renderPager() {
  const from = state.total === 0 ? 0 : state.page * PAGE_SIZE + 1
  const to = Math.min((state.page + 1) * PAGE_SIZE, state.total)
  $('#range').textContent = `Showing ${from}–${to} of ${state.total}`
  $('#prev').disabled = state.page === 0
  $('#next').disabled = (state.page + 1) * PAGE_SIZE >= state.total
}

export const PARTICIPANT_COLUMNS = (isEnded) => [
  { header: 'Full name', value: (r) => r.full_name },
  { header: 'Email', value: (r) => r.email },
  { header: 'Phone', value: (r) => r.phone },
  { header: 'Church', value: (r) => r.church_name },
  { header: 'Reference', value: (r) => r.registration_reference },
  { header: 'Registered at', value: (r) => formatDateTime(r.created_at) },
  { header: 'Attendance', value: (r) => attendanceLabel(r, isEnded).text },
  { header: 'Checked in at', value: (r) => (r.checked_in_at ? formatDateTime(r.checked_in_at) : '') },
]

// Fetches every row matching the current filters (in chunks) for export.
export async function fetchAllRegistrations(id, { search = '', filter = 'all', sort = 'name_asc' } = {}) {
  const all = []
  const chunk = 1000
  for (let offset = 0; ; offset += chunk) {
    const data = await callRpc('admin_list_registrations', {
      p_event_id: id, p_search: search, p_filter: filter, p_sort: sort, p_limit: chunk, p_offset: offset,
    })
    all.push(...data.rows)
    if (all.length >= data.total || data.rows.length === 0) break
  }
  return all
}

async function exportCsv() {
  try {
    const rows = await fetchAllRegistrations(eventId, state)
    downloadFile(`${slug(report.name)}-participants.csv`, toCsv(PARTICIPANT_COLUMNS(ended), rows))
    toast(`Exported ${rows.length} participant(s)`)
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

export async function initEventRegistrations() {
  const session = await requireAdmin('events')
  if (!session) return

  eventId = param('id')
  if (!isUuid(eventId)) {
    notice($('#status'), 'No event selected. Choose an event from the events list.', 'warning')
    return
  }

  try {
    await loadReport()
  } catch (e) {
    notice($('#status'), errorText(e), 'error')
    return
  }

  const reset = () => {
    state.page = 0
    loadPage()
  }
  $('#search').addEventListener('input', debounce((e) => {
    state.search = e.target.value.trim()
    reset()
  }, 300))
  $('#filter').addEventListener('change', (e) => {
    state.filter = e.target.value
    reset()
  })
  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value
    reset()
  })
  $('#prev').addEventListener('click', () => {
    state.page = Math.max(0, state.page - 1)
    loadPage()
  })
  $('#next').addEventListener('click', () => {
    state.page += 1
    loadPage()
  })
  $('#export').addEventListener('click', exportCsv)

  await loadPage()
}
