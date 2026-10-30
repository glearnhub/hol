// Mentee report: every deaconess with the members she mentors listed under her, on the
// same letterhead as the other reports. Opened with ?print=1 it goes straight to the print
// dialog (from the "Mentee report" button on the Deaconesses page).
import { requireAdmin } from './admin-auth.js'
import { callRpc, errorText, membershipTypeLabel } from './admin-common.js'
import { el, $, setChildren, notice, toast, toCsv, downloadFile, param } from './ui.js'

let data = null

const opts = () => ({
  unassigned: $('#opt-unassigned').checked,
  inactive: $('#opt-inactive').checked,
  phone: $('#opt-phone').checked,
})

function statBox(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label))
}

function menteeTable(list, showPhone) {
  const heads = ['No.', 'Name', 'Member no.', 'Membership type', showPhone ? 'Phone' : null].filter(Boolean)
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'data report-table' },
      el('thead', {}, el('tr', {}, ...heads.map((h) => el('th', {}, h)))),
      el(
        'tbody',
        {},
        ...list.map((m, i) =>
          el(
            'tr',
            {},
            el('td', { class: 'num' }, String(i + 1)),
            el('td', {}, m.full_name, m.status === 'inactive' ? el('span', { class: 'badge badge-muted' }, 'Inactive') : null),
            el('td', {}, m.label),
            el('td', {}, membershipTypeLabel(m.membership_type)),
            showPhone ? el('td', {}, m.phone) : null
          )
        )
      )
    )
  )
}

function render() {
  const o = opts()
  const deaconesses = data.deaconesses.filter((d) => o.inactive || d.active)
  const mentees = deaconesses.reduce((n, d) => n + d.mentees.length, 0)

  setChildren(
    $('#report'),
    el(
      'header',
      { class: 'report-head' },
      el('img', { src: 'img/logo.png', alt: 'Handmaidens of the Lord', class: 'report-logo', width: '1064', height: '811' }),
      el(
        'div',
        { class: 'report-title' },
        el('h2', {}, 'Mentee report'),
        el('div', { class: 'report-event' }, 'Deaconesses and the members they mentor'),
        el('div', { class: 'muted report-generated' }, `Generated ${new Date().toLocaleString()}`)
      )
    ),
    el(
      'div',
      { class: 'stats' },
      statBox(deaconesses.length, 'Deaconesses'),
      statBox(mentees, 'Mentees'),
      o.unassigned ? statBox(data.unassigned.length, 'Members without a deaconess') : null
    ),
    deaconesses.length === 0 ? el('p', { class: 'muted' }, 'There are no deaconesses yet.') : null,
    ...deaconesses.map((d, i) =>
      el(
        'section',
        { class: 'report-section mentee-section' },
        el(
          'h3',
          {},
          `${i + 1}. ${d.name}`,
          d.group_name ? el('span', { class: 'mentee-group' }, ` — ${d.group_name}`) : null,
          d.active ? null : el('span', { class: 'badge badge-muted' }, 'Inactive')
        ),
        el('p', { class: 'muted' }, `${d.mentees.length} mentee${d.mentees.length === 1 ? '' : 's'}${o.phone && d.phone ? ` · ${d.phone}` : ''}`),
        d.mentees.length ? menteeTable(d.mentees, o.phone) : el('p', { class: 'muted' }, 'No mentees yet.')
      )
    ),
    o.unassigned
      ? el(
          'section',
          { class: 'report-section mentee-section' },
          el('h3', {}, 'Members without a deaconess'),
          el('p', { class: 'muted' }, `${data.unassigned.length} active member${data.unassigned.length === 1 ? '' : 's'}`),
          data.unassigned.length ? menteeTable(data.unassigned, o.phone) : el('p', { class: 'muted' }, 'Every active member has a deaconess.')
        )
      : null
  )
}

function exportCsv() {
  if (!data) return
  const o = opts()
  const rows = []
  for (const d of data.deaconesses.filter((x) => o.inactive || x.active)) {
    if (d.mentees.length === 0) rows.push({ d, m: null })
    for (const m of d.mentees) rows.push({ d, m })
  }
  if (o.unassigned) for (const m of data.unassigned) rows.push({ d: null, m })
  const columns = [
    { header: 'Deaconess', value: (r) => (r.d ? r.d.name : 'No deaconess') },
    { header: 'Group', value: (r) => (r.d ? r.d.group_name || '' : '') },
    { header: 'Mentee', value: (r) => (r.m ? r.m.full_name : '') },
    { header: 'Member no.', value: (r) => (r.m ? r.m.label : '') },
    { header: 'Membership type', value: (r) => (r.m ? membershipTypeLabel(r.m.membership_type) : '') },
    ...(o.phone ? [{ header: 'Phone', value: (r) => (r.m ? r.m.phone : '') }] : []),
  ]
  downloadFile('mentee-report.csv', toCsv(columns, rows))
  toast('Mentee report exported')
}

export async function initMenteeReport() {
  const session = await requireAdmin('deaconesses')
  if (!session) return

  try {
    data = await callRpc('admin_mentee_report')
  } catch (e) {
    notice($('#status'), errorText(e), 'error')
    return
  }
  render()
  for (const id of ['#opt-unassigned', '#opt-inactive', '#opt-phone']) $(id).addEventListener('change', render)
  $('#print').addEventListener('click', () => window.print())
  $('#export').addEventListener('click', exportCsv)

  // Opened from the "Mentee report" button: show the print dialog once the page has drawn.
  if (param('print') === '1') setTimeout(() => window.print(), 600)
}
