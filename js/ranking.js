// Annual attendance: the ranking of people by meetings attended in a calendar year, with
// a summary, a monthly chart, a breakdown by event type and a "not seen lately" list.
// Every number comes from the admin_annual_attendance database function.
import { requireAdmin } from './admin-auth.js'
import { callRpc, errorText, kindBadge, CATEGORIES } from './admin-common.js'
import { el, $, formatDate, notice, toast, toCsv, downloadFile, debounce } from './ui.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
let data = null
let chart = null

function statCard(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label))
}

function args() {
  return {
    p_year: Number($('#f-year').value),
    p_scope: $('#f-scope').value,
    p_include_zero: $('#f-zero').checked,
    p_category: $('#f-category').value || null,
  }
}

async function load() {
  const status = $('#status')
  try {
    data = await callRpc('admin_annual_attendance', args())
    status.replaceChildren()
  } catch (e) {
    notice(status, errorText(e), 'error')
    return
  }
  renderSummary()
  renderRanking()
  renderCategories()
  renderCompare()
  await renderChart()
}

function renderSummary() {
  const s = data.summary
  const cards = [
    statCard(s.meetings_held, `Meetings held in ${data.year}`),
    statCard(s.active_members, 'Active members'),
    statCard(s.members_attended_any, 'Members who attended at least one'),
    statCard(s.members_attended_none, 'Members who attended none'),
    statCard(s.member_attendance_records, 'Member attendances (all meetings)'),
    statCard(s.participation_rate === null || s.participation_rate === undefined ? '—' : `${s.participation_rate}%`, 'Participation rate'),
    statCard(s.visitors_attended_any, 'Different visitors who attended'),
  ]
  $('#stats').replaceChildren(...cards)
}

function filteredRanking() {
  const q = $('#f-search').value.trim().toLowerCase()
  const digits = q.replace(/\D/g, '').replace(/^0+/, '')
  if (!q) return data.ranking
  return data.ranking.filter(
    (r) => r.full_name.toLowerCase().includes(q) || r.label.toLowerCase() === q || (digits.length >= 3 && r.phone.includes(digits))
  )
}

function renderRanking() {
  const scopeText = { members: 'Members', visitors: 'Visitors', all: 'Members and visitors' }[data.scope]
  $('#ranking-title').textContent = `${scopeText} ranked by meetings attended in ${data.year}`
  const rows = filteredRanking()
  const host = $('#ranking')
  if (rows.length === 0) {
    host.replaceChildren(el('p', { class: 'muted' }, data.ranking.length ? 'Nobody matches that search.' : 'No attendance has been recorded for these filters yet.'))
    return
  }
  const showKind = data.scope === 'all'
  host.replaceChildren(
    el(
      'table',
      { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Rank', 'Name', 'Phone', showKind ? 'Type' : null, 'Meetings attended', 'Last attended'].filter(Boolean).map((h) => el('th', {}, h)))),
      el(
        'tbody',
        {},
        ...rows.map((r) =>
          el(
            'tr',
            {},
            el('td', { class: 'num' }, el('strong', {}, String(r.rank))),
            el('td', {}, el('strong', {}, r.full_name), el('div', { class: 'muted' }, r.label)),
            el('td', {}, r.phone),
            showKind ? el('td', {}, kindBadge(r.kind)) : null,
            el('td', {}, el('strong', {}, String(r.meetings_attended))),
            el('td', {}, r.last_attended ? formatDate(String(r.last_attended).slice(0, 10)) : 'Never')
          )
        )
      )
    )
  )
}

function renderCategories() {
  const host = $('#categories')
  if (!data.categories.length) {
    host.replaceChildren(el('p', { class: 'muted' }, 'No meetings in this year yet.'))
    return
  }
  host.replaceChildren(
    el(
      'table',
      { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Event type', 'Meetings', 'Member attendances', 'Visitor attendances'].map((h) => el('th', {}, h)))),
      el(
        'tbody',
        {},
        ...data.categories.map((c) =>
          el('tr', {}, el('td', {}, CATEGORIES[c.category] || c.category), el('td', {}, String(c.meetings)), el('td', {}, String(c.member_attendance)), el('td', {}, String(c.visitor_attendance)))
        )
      )
    )
  )
}

function renderCompare() {
  const prev = data.previous
  $('#prev-year').textContent = String(prev.year)
  const s = data.summary
  const mine = { meetings: s.meetings_total, records: s.member_attendance_records + s.visitor_attendance_records }
  const diff = (a, b) => (a === b ? 'same' : a > b ? `+${a - b}` : `${a - b}`)
  $('#compare').replaceChildren(
    el(
      'table',
      { class: 'data' },
      el('thead', {}, el('tr', {}, ...['', String(data.year), String(prev.year), 'Change'].map((h) => el('th', {}, h)))),
      el(
        'tbody',
        {},
        el('tr', {}, el('td', {}, 'Meetings'), el('td', {}, String(mine.meetings)), el('td', {}, String(prev.meetings)), el('td', {}, diff(mine.meetings, prev.meetings))),
        el('tr', {}, el('td', {}, 'Attendances'), el('td', {}, String(mine.records)), el('td', {}, String(prev.attendance_records)), el('td', {}, diff(mine.records, prev.attendance_records)))
      )
    )
  )
}

async function renderChart() {
  const canvas = $('#chart')
  if (!data.monthly.some((m) => m.meetings > 0)) {
    canvas.style.display = 'none'
    if (!$('#chart-empty')) canvas.parentElement.append(el('p', { id: 'chart-empty', class: 'muted' }, 'The chart appears once meetings with attendance have been held.'))
    return
  }
  canvas.style.display = ''
  $('#chart-empty')?.remove()
  const { default: Chart } = await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.4/auto/+esm')
  chart?.destroy()
  chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: MONTHS,
      datasets: [
        { label: 'Members', data: data.monthly.map((m) => m.member_attendance), backgroundColor: '#600086' },
        { label: 'Visitors', data: data.monthly.map((m) => m.visitor_attendance), backgroundColor: '#e0a800' },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  })
}

async function loadLapsed() {
  const host = $('#lapsed')
  try {
    const res = await callRpc('admin_lapsed_members', { p_days: Number($('#f-days').value) })
    if (!res.rows.length) {
      host.replaceChildren(el('p', { class: 'muted' }, 'Every active member has been to a meeting in that time.'))
      return
    }
    host.replaceChildren(
      el('p', { class: 'muted' }, `${res.rows.length} active member(s)`),
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Member', 'Phone', 'Last attended', 'Days since'].map((h) => el('th', {}, h)))),
        el(
          'tbody',
          {},
          ...res.rows.map((r) =>
            el(
              'tr',
              {},
              el('td', {}, el('strong', {}, r.full_name), el('div', { class: 'muted' }, r.label)),
              el('td', {}, r.phone),
              el('td', {}, r.last_attended ? formatDate(String(r.last_attended).slice(0, 10)) : 'Never'),
              el('td', {}, r.days_since === null || r.days_since === undefined ? '—' : String(r.days_since))
            )
          )
        )
      )
    )
  } catch (e) {
    notice(host, errorText(e), 'error')
  }
}

function exportCsv() {
  if (!data) return
  const rows = filteredRanking()
  const columns = [
    { header: 'Rank', value: (r) => r.rank },
    { header: 'ID', value: (r) => r.label },
    { header: 'Full name', value: (r) => r.full_name },
    { header: 'Phone', value: (r) => r.phone },
    { header: 'Type', value: (r) => r.kind },
    { header: `Meetings attended in ${data.year}`, value: (r) => r.meetings_attended },
    { header: 'Last attended', value: (r) => (r.last_attended ? String(r.last_attended).slice(0, 10) : '') },
  ]
  downloadFile(`attendance-ranking-${data.year}-${data.scope}.csv`, toCsv(columns, rows))
  toast(`Exported ${rows.length} row(s)`)
}

export async function initRanking() {
  const session = await requireAdmin('ranking')
  if (!session) return

  const thisYear = new Date().getFullYear()
  $('#f-year').replaceChildren(
    ...Array.from({ length: 8 }, (_, i) => thisYear + 1 - i).map((y) => el('option', { value: String(y), ...(y === thisYear ? { selected: true } : {}) }, String(y)))
  )
  $('#f-category').append(...Object.entries(CATEGORIES).map(([k, label]) => el('option', { value: k }, label)))

  for (const id of ['#f-year', '#f-scope', '#f-category', '#f-zero']) $(id).addEventListener('change', load)
  $('#f-search').addEventListener('input', debounce(() => data && renderRanking(), 200))
  $('#f-days').addEventListener('change', loadLapsed)
  $('#export').addEventListener('click', exportCsv)
  $('#print').addEventListener('click', () => window.print())

  await Promise.all([load(), loadLapsed()])
}
