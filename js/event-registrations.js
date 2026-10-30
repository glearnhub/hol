// Participant list for one event: search, filter, sort, paginate, export, mark present.
import { requireAdmin } from './admin-auth.js'
import { callRpc, attendanceBadge, attendanceLabel, errorText, kindBadge, membershipBadge } from './admin-common.js'
import {
  el, $, param, isUuid, formatDate, formatTimeRange, formatDateTime, notice, toast, toCsv, downloadFile,
  debounce, slug,
  formatSchedule,
} from './ui.js'

const PAGE_SIZE = 20
let eventId = null
let ended = false
let report = null
let isAdmin = false
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
    `${formatSchedule(report)} · ${report.venue}`
  document.title = `${report.name} registrations · Handmaidens of the Lord`

  $('#stats').replaceChildren(
    statCard(`${report.registrations} / ${report.capacity}`, 'Registered'),
    statCard(report.unique_attendees ?? report.attendees, 'Present (everyone)'),
    statCard(report.members_attended ?? 0, 'Members present'),
    statCard(report.visitors_attended ?? 0, 'Visitors present'),
    statCard(ended ? report.absentees : report.not_checked_in, ended ? 'Absent' : 'Not yet checked in'),
    statCard(`${report.attendance_percentage}%`, 'Registered who attended'),
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
        el('tr', {}, ...['Name', 'Type', 'Email', 'Phone', 'Church', 'Registered', 'Attendance', 'Checked in', ''].map((h) => el('th', {}, h)))
      ),
      el(
        'tbody',
        {},
        ...rows.map((r) =>
          el(
            'tr',
            {},
            el('td', {}, el('strong', {}, r.full_name), el('div', { class: 'muted' }, r.registration_reference)),
            el('td', {}, kindBadge(r.classification || 'visitor')),
            el('td', {}, r.email || '—'),
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
    isAdmin ? el('button', { class: 'btn btn-danger btn-small', type: 'button', onclick: () => cancelRegistration(r) }, 'Cancel') : null
  )
}

async function setPresent(r, present) {
  try {
    let reason = null
    if (!present) {
      // Taking someone off the attendance list keeps a copy and the reason.
      reason = prompt(`Why is ${r.full_name} being removed from the attendance list? (for example "marked by mistake")`)
      if (reason === null) return
    }
    await callRpc('admin_set_attendance', { p_registration_id: r.id, p_present: present, p_reason: reason })
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
  { header: 'Type', value: (r) => (r.classification === 'member' ? 'Member' : 'Visitor') },
  { header: 'Email', value: (r) => r.email || '' },
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

// ---- Mark anyone present (members who were missed, people who did not register) ----
async function searchPeople() {
  const q = $('#mark-search').value.trim()
  const host = $('#mark-results')
  if (q.length < 3) {
    host.replaceChildren()
    return
  }
  try {
    const data = await callRpc('staff_search_people', { p_event_id: eventId, p_query: q })
    if (data.results.length === 0) {
      host.replaceChildren(el('p', { class: 'muted' }, 'Nobody found. Members are added on the Members page; new visitors are registered by ushers or through the registration link.'))
      return
    }
    host.replaceChildren(
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Name', 'Type', 'Phone', 'Registered', 'Attendance', ''].map((h) => el('th', {}, h)))),
        el(
          'tbody',
          {},
          ...data.results.map((p) =>
            el(
              'tr',
              {},
              el('td', {}, el('strong', {}, p.full_name), el('div', { class: 'muted' }, p.label)),
              el('td', {}, membershipBadge(p.membership_type)),
              el('td', {}, p.phone),
              el('td', {}, p.registered ? 'Yes' : 'No'),
              el('td', {}, p.checked_in ? el('span', { class: 'badge badge-success' }, `Present ${formatDateTime(p.checked_in_at)}`) : el('span', { class: 'badge badge-muted' }, 'Not present')),
              el('td', {}, p.checked_in
                ? el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => setPersonPresent(p, false) }, 'Remove')
                : el('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => setPersonPresent(p, true) }, 'Mark present'))
            )
          )
        )
      )
    )
  } catch (e) {
    notice(host, errorText(e), 'error')
  }
}

async function setPersonPresent(p, present) {
  let reason = null
  if (!present) {
    reason = prompt(`Why is ${p.full_name} being removed from the attendance list? (for example "marked by mistake")`)
    if (reason === null) return
  }
  try {
    await callRpc('admin_set_person_attendance', { p_event_id: eventId, p_person_id: p.person_id, p_present: present, p_reason: reason })
    toast(present ? `${p.full_name} marked present` : 'Attendance removed (a copy is kept in the history)')
    await Promise.all([loadReport(), loadPage(), searchPeople()])
  } catch (e) {
    toast(errorText(e), 'error')
  }
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

// ---- Thank-you email: gather the addresses of everyone who attended ---------------
let attendeeEmails = []

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text)
    toast(okMessage)
  } catch {
    // Older browsers / blocked clipboard: select the text so Ctrl+C works.
    toast('Select the text and press Copy (Ctrl+C) on your keyboard.', 'error')
  }
}

function emailSeparator() {
  return $('#outlook-sep').checked ? '; ' : ', '
}

function paintEmailList() {
  $('#email-list').value = attendeeEmails.join(emailSeparator())
}

async function loadThankYou() {
  const summary = $('#thank-summary')
  summary.textContent = 'Loading…'
  try {
    const rows = await fetchAllRegistrations(eventId, { filter: 'present', sort: 'name_asc' })
    const seen = new Set()
    attendeeEmails = []
    for (const r of rows) {
      const email = String(r.email || '').trim()
      if (email && !seen.has(email.toLowerCase())) {
        seen.add(email.toLowerCase())
        attendeeEmails.push(email)
      }
    }
    summary.textContent = attendeeEmails.length
      ? `${attendeeEmails.length} email address${attendeeEmails.length === 1 ? '' : 'es'} from ${rows.length} attendee${rows.length === 1 ? '' : 's'} checked in` +
        (rows.length > attendeeEmails.length ? ' (the others did not give an email address).' : '.')
      : rows.length
        ? 'The attendees who checked in did not give email addresses.'
        : 'Nobody has been checked in for this event yet, so there are no addresses to copy.'
    paintEmailList()
    $('#copy-emails').disabled = $('#open-mail').disabled = attendeeEmails.length === 0
  } catch (e) {
    summary.textContent = errorText(e)
  }
  const subject = `Thank you for attending ${report.name}`
  $('#thank-subject').value = subject
  $('#thank-body').value = [
    'Dear friend,',
    '',
    `Thank you for joining us at ${report.name} on ${formatDate(report.event_date)}. It was a joy to have you with us, and we pray that you were blessed.`,
    '',
    'We look forward to seeing you again at our next event.',
    '',
    'God bless you.',
    '',
    'Handmaidens of the Lord',
  ].join(String.fromCharCode(10))
}

function initThankYou() {
  const panel = $('#thank-panel')
  const toggle = $('#thank-you')
  toggle.addEventListener('click', async () => {
    const open = panel.classList.contains('hidden')
    panel.classList.toggle('hidden', !open)
    toggle.setAttribute('aria-expanded', String(open))
    if (open) {
      await loadThankYou()
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  })
  $('#outlook-sep').addEventListener('change', paintEmailList)
  $('#copy-emails').addEventListener('click', () =>
    copyText(attendeeEmails.join(emailSeparator()), `${attendeeEmails.length} email address(es) copied`)
  )
  $('#copy-subject').addEventListener('click', () => copyText($('#thank-subject').value, 'Subject copied'))
  $('#copy-message').addEventListener('click', () => copyText($('#thank-body').value, 'Message copied'))
  $('#open-mail').addEventListener('click', () => {
    // BCC keeps attendees' addresses private from each other. Very long lists do not fit
    // in a mailto link, so those must be pasted instead.
    const bcc = attendeeEmails.join(',')
    const href =
      `mailto:?bcc=${encodeURIComponent(bcc)}` +
      `&subject=${encodeURIComponent($('#thank-subject').value)}` +
      `&body=${encodeURIComponent($('#thank-body').value)}`
    if (href.length > 1800) {
      toast('The list is too long for a link. Use “Copy emails” and paste into BCC.', 'error')
      return
    }
    window.location.href = href
  })
}

export async function initEventRegistrations() {
  const session = await requireAdmin('events', { roles: ['admin', 'manager'] })
  if (!session) return
  isAdmin = session.role === 'admin'
  if (!isAdmin) {
    $('#thank-you').classList.add('hidden')
    notice($('#status'), 'You can mark people present and correct mistakes. Phone numbers are partly hidden, and only administrators can cancel registrations.', 'info')
  }

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
  $('#mark-search').addEventListener('input', debounce(searchPeople, 350))
  $('#report-link').href = `reports.html?id=${eventId}`
  if (isAdmin) initThankYou()

  await loadPage()
}
