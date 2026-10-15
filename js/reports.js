// Event report: the people registered for one event and whether each attended.
import { supabase } from './supabase-client.js'
import { requireAdmin } from './admin-auth.js'
import { callRpc, errorText } from './admin-common.js'
import { fetchAllRegistrations } from './event-registrations.js'
import {
  el, $, param, isUuid, formatDate, formatTimeRange, notice, toast, toCsv, downloadFile, slug,
} from './ui.js'

let current = null // { report, participants }

const attended = (p) => Boolean(p.checked_in_at)

function mark(p) {
  return attended(p)
    ? el('span', { class: 'mark mark-yes', role: 'img', 'aria-label': 'Attended', title: 'Attended' }, '✓')
    : el('span', { class: 'mark mark-no', role: 'img', 'aria-label': 'Did not attend', title: 'Did not attend' }, '✗')
}

function renderReport() {
  const { report: r, participants } = current
  const host = $('#report')

  const rows = participants.map((p, i) =>
    el(
      'tr',
      {},
      el('td', { class: 'num' }, String(i + 1)),
      el('td', {}, p.full_name),
      el('td', {}, p.phone),
      el('td', {}, p.church_name),
      el('td', { class: 'attendance-cell' }, mark(p))
    )
  )

  host.replaceChildren(
    el(
      'header',
      { class: 'report-head' },
      el('img', { src: 'img/logo.png', alt: 'Handmaidens of the Lord', class: 'report-logo', width: '1064', height: '811' }),
      el(
        'div',
        { class: 'report-title' },
        el('h2', {}, 'Attendance report'),
        el('div', { class: 'report-event' }, r.name),
        el('div', { class: 'muted' }, `${formatDate(r.event_date)} · ${formatTimeRange(r.start_time, r.end_time)}`),
        el('div', { class: 'muted' }, r.venue),
        el('div', { class: 'muted report-generated' }, `Generated ${new Date().toLocaleString()}`)
      )
    ),
    el(
      'div',
      { class: 'report-legend' },
      el('span', {}, el('span', { class: 'mark mark-yes' }, '✓'), ' Attended'),
      el('span', {}, el('span', { class: 'mark mark-no' }, '✗'), ' Did not attend'),
      el('span', { class: 'muted' }, `${participants.length} registered`)
    ),
    r.completed
      ? null
      : el(
          'div',
          { class: 'notice notice-info no-print' },
          'This event has not finished yet. A ✗ means the person has not checked in so far.'
        ),
    participants.length
      ? el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            { class: 'data report-table' },
            el(
              'thead',
              {},
              el('tr', {}, ...['No.', 'Full name', 'Phone', 'Church', 'Attendance'].map((h) => el('th', {}, h)))
            ),
            el('tbody', {}, ...rows)
          )
        )
      : el('p', { class: 'muted' }, 'Nobody has registered for this event yet.')
  )
}

async function showEvent(id) {
  const host = $('#report')
  host.replaceChildren(el('p', { class: 'muted' }, 'Loading report…'))
  try {
    const [data, participants] = await Promise.all([
      callRpc('admin_event_report', { p_event_id: id }),
      fetchAllRegistrations(id, { filter: 'all', sort: 'name_asc' }),
    ])
    current = { report: data.report, participants }
    renderReport()
    const url = new URL(window.location.href)
    url.searchParams.set('id', id)
    window.history.replaceState(null, '', url)
  } catch (e) {
    notice(host, errorText(e), 'error')
  }
}

export async function initReports() {
  const session = await requireAdmin('reports')
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
    ...events.map((e) => el('option', { value: e.id }, `${e.name} (${formatDate(e.event_date)})`))
  )
  const wanted = param('id')
  if (isUuid(wanted) && events.some((e) => e.id === wanted)) select.value = wanted
  select.addEventListener('change', () => showEvent(select.value))

  $('#print').addEventListener('click', () => window.print())

  $('#export').addEventListener('click', () => {
    if (!current) return
    // toCsv receives only the row, so the running number is attached to each row.
    const rows = current.participants.map((p, i) => ({ ...p, rowNumber: i + 1 }))
    const columns = [
      { header: 'No.', value: (p) => p.rowNumber },
      { header: 'Full name', value: (p) => p.full_name },
      { header: 'Phone', value: (p) => p.phone },
      { header: 'Church', value: (p) => p.church_name },
      { header: 'Attendance', value: (p) => (attended(p) ? 'Attended' : 'Did not attend') },
    ]
    downloadFile(`${slug(current.report.name)}-report.csv`, toCsv(columns, rows))
    toast('Report exported')
  })

  await showEvent(select.value)
}
