// Administrator dashboard: totals, a chart and recent events.
import { requireAdmin } from './admin-auth.js'
import { callRpc, eventStatusBadge, errorText } from './admin-common.js'
import { el, $, formatDate, notice } from './ui.js'

function statCard(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label))
}

export async function initDashboard() {
  const session = await requireAdmin('dashboard')
  if (!session) return

  const status = $('#status')
  try {
    const [stats, overview] = await Promise.all([
      callRpc('admin_dashboard_stats'),
      callRpc('admin_reports_overview'),
    ])

    $('#stats').replaceChildren(
      statCard(stats.total_events, 'Total events'),
      statCard(stats.upcoming_events, 'Upcoming events'),
      statCard(stats.total_registrations, 'Total registrations'),
      statCard(stats.total_attendees, 'Total attendees'),
      statCard(stats.total_absentees, 'Absentees (completed events)')
    )

    const events = overview.events || []
    renderRecent(events.slice(0, 6))
    await renderChart(events.filter((e) => e.status !== 'draft').slice(0, 8).reverse())
  } catch (e) {
    notice(status, errorText(e), 'error')
  }
}

function renderRecent(events) {
  const host = $('#recent')
  if (events.length === 0) {
    host.replaceChildren(el('p', { class: 'muted' }, 'No events yet. Create your first event to get started.'))
    return
  }
  host.replaceChildren(
    el(
      'table',
      { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Event', 'Date', 'Status', 'Registered', 'Attended', ''].map((h) => el('th', {}, h)))),
      el(
        'tbody',
        {},
        ...events.map((e) =>
          el(
            'tr',
            {},
            el('td', {}, el('strong', {}, e.name), el('div', { class: 'muted' }, e.venue)),
            el('td', {}, formatDate(e.event_date)),
            el('td', {}, eventStatusBadge(e.status)),
            el('td', {}, `${e.registrations} / ${e.capacity}`),
            el('td', {}, String(e.attendees)),
            el('td', {}, el('a', { class: 'btn btn-outline btn-small', href: `event-registrations.html?id=${e.event_id}` }, 'Open'))
          )
        )
      )
    )
  )
}

async function renderChart(events) {
  const canvas = $('#chart')
  if (events.length === 0) {
    canvas.parentElement.replaceChildren(el('p', { class: 'muted' }, 'The chart appears once you have published events.'))
    return
  }
  const { default: Chart } = await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.4/auto/+esm')
  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: events.map((e) => (e.name.length > 22 ? e.name.slice(0, 21) + '…' : e.name)),
      datasets: [
        { label: 'Registered', data: events.map((e) => e.registrations), backgroundColor: '#8e24aa' },
        { label: 'Attended', data: events.map((e) => e.attendees), backgroundColor: '#15803D' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  })
}
