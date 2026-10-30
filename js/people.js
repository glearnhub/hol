// Member and visitor directory (administrators only).
//   members.html  -> initPeople('member')   register, edit, activate / deactivate, profiles
//   visitors.html -> initPeople('visitor')  review, find repeat visitors, convert to member
//
// This file only decides what to SHOW. Every action runs in an admin_* database function
// that checks the user's role again.
import { supabase } from './supabase-client.js'
import { requireAdmin } from './admin-auth.js'
import { callRpc, errorText, kindBadge, MEMBERSHIP_TYPES, membershipBadge, membershipTypeLabel } from './admin-common.js'
import { initImport } from './people-import.js'
import { el, $, setChildren, formatDate, formatDateTime, notice, toast, toCsv, downloadFile, debounce, slug } from './ui.js'

const PAGE_SIZE = 20

let MODE = 'member'
const state = { page: 0, search: '', status: 'all', type: 'all', department: '', deaconess: '', attended: 'all', from: '', to: '', sort: 'name_asc', review: false, repeat: false, total: 0 }
let formMode = 'create' // 'create' | 'edit' | 'convert'
let formPerson = null
let profileYear = null

const noun = () => (MODE === 'member' ? 'member' : 'visitor')

// A direct call, so the duplicate lists in a refusal are kept (callRpc would throw them away).
async function rpcRaw(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(error.message || 'Request failed')
  return data
}

function listArgs(extra = {}) {
  return {
    p_kind: MODE,
    p_search: state.search,
    p_status: state.status,
    p_type: state.type,
    p_department: state.department || null,
    p_deaconess_id: state.deaconess || null,
    p_attended: state.attended,
    p_from: state.from || null,
    p_to: state.to || null,
    p_sort: state.sort,
    p_review: state.review,
    p_min_attended: state.repeat ? 2 : null,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------
function statCard(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label))
}

async function refreshStats() {
  const base = { p_kind: MODE, p_limit: 1, p_offset: 0 }
  try {
    const types = MODE === 'member' ? ['member', 'in_commitment', 'incoming_commitment'] : []
    const [all, active, review, ...byType] = await Promise.all([
      callRpc('admin_list_people', { ...base, p_status: 'all' }),
      callRpc('admin_list_people', { ...base, p_status: 'active' }),
      callRpc('admin_list_people', { ...base, p_review: true }),
      ...types.map((t) => callRpc('admin_list_people', { ...base, p_type: t })),
    ])
    $('#stats').replaceChildren(
      statCard(all.total, MODE === 'member' ? 'All people in the directory' : 'Visitors'),
      ...types.map((t, i) => statCard(byType[i].total, MEMBERSHIP_TYPES[t] === 'Member' ? 'Members' : MEMBERSHIP_TYPES[t])),
      statCard(all.total - active.total, 'Inactive'),
      statCard(review.total, 'Need review')
    )
  } catch {
    $('#stats').replaceChildren()
  }
}

async function loadPage() {
  try {
    const data = await callRpc('admin_list_people', listArgs({ p_limit: PAGE_SIZE, p_offset: state.page * PAGE_SIZE }))
    state.total = data.total
    renderTable(data.rows)
    renderPager()
    $('#status').replaceChildren()
  } catch (e) {
    notice($('#status'), errorText(e), 'error')
  }
}

function renderTable(rows) {
  const host = $('#table')
  if (rows.length === 0) {
    host.replaceChildren(el('p', { class: 'muted' }, `No ${noun()}s match these filters.`))
    return
  }
  const rangeLabel = state.from || state.to ? 'In period' : 'Meetings'
  const heads =
    MODE === 'member'
      ? ['Member', 'Phone', 'Membership type', 'Department · deaconess · residence', 'Status', 'Attended', rangeLabel, 'Last attended', '']
      : ['Visitor', 'Phone', 'Church', 'Registrations', 'Attended', rangeLabel, 'Last attended', '']

  host.replaceChildren(
    el(
      'table',
      { class: 'data' },
      el('thead', {}, el('tr', {}, ...heads.map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows.map((p) => row(p)))
    )
  )
}

function row(p) {
  const name = el(
    'td',
    {},
    el('strong', {}, p.full_name),
    el('div', { class: 'muted' }, p.label),
    p.needs_review ? el('span', { class: 'badge badge-warning', title: p.review_note || 'Possible duplicate' }, 'Needs review') : null
  )
  const statusBadge = el('span', { class: `badge badge-${p.status === 'active' ? 'success' : 'muted'}` }, p.status === 'active' ? 'Active' : 'Inactive')
  const actions = el(
    'div',
    { class: 'row-actions' },
    el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => openProfile(p.id) }, 'View'),
    MODE === 'visitor'
      ? el('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => openForm('convert', p) }, 'Convert to member')
      : null,
    el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => openForm('edit', p) }, 'Edit'),
    MODE === 'member'
      ? el(
          'button',
          { class: 'btn btn-outline btn-small', type: 'button', onclick: () => changeStatus(p, p.status === 'active' ? 'inactive' : 'active') },
          p.status === 'active' ? 'Deactivate' : 'Activate'
        )
      : null
  )
  const cells =
    MODE === 'member'
      ? [
          name,
          el('td', {}, p.phone),
          el('td', {}, membershipBadge(p.membership_type)),
          el(
            'td',
            {},
            p.department ? el('div', {}, el('strong', {}, p.department)) : null,
            p.deaconess ? el('div', { class: 'muted' }, `Deaconess: ${p.deaconess}`) : null,
            p.residence ? el('div', { class: 'muted' }, p.residence) : null,
            !p.department && !p.deaconess && !p.residence ? '—' : null
          ),
          el('td', {}, statusBadge),
          el('td', {}, String(p.attended_total)),
          el('td', {}, String(p.attended_range)),
          el('td', {}, p.last_attended ? formatDate(p.last_attended) : 'Never'),
          el('td', {}, actions),
        ]
      : [
          name,
          el('td', {}, p.phone),
          el('td', {}, p.church_name || '—'),
          el('td', {}, String(p.registrations)),
          el('td', {}, String(p.attended_total)),
          el('td', {}, String(p.attended_range)),
          el('td', {}, p.last_attended ? formatDate(p.last_attended) : 'Never'),
          el('td', {}, actions),
        ]
  return el('tr', {}, ...cells)
}

function renderPager() {
  const from = state.total === 0 ? 0 : state.page * PAGE_SIZE + 1
  const to = Math.min((state.page + 1) * PAGE_SIZE, state.total)
  $('#range').textContent = `Showing ${from}–${to} of ${state.total}`
  $('#prev').disabled = state.page === 0
  $('#next').disabled = (state.page + 1) * PAGE_SIZE >= state.total
}

async function changeStatus(p, status) {
  const verb = status === 'inactive' ? 'Deactivate' : 'Activate'
  const extra = status === 'inactive' ? ' They will no longer appear when ushers search, but their history is kept.' : ''
  if (!confirm(`${verb} ${p.full_name}?${extra}`)) return
  try {
    await callRpc('admin_set_person_status', { p_id: p.id, p_status: status })
    toast(status === 'active' ? `${p.full_name} is active again` : `${p.full_name} deactivated`)
    await Promise.all([loadPage(), refreshStats()])
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

// ---------------------------------------------------------------------------
// Export (the whole filtered list, not just the page on screen)
// ---------------------------------------------------------------------------
async function exportCsv() {
  try {
    const rows = []
    const chunk = 1000
    for (let offset = 0; ; offset += chunk) {
      const data = await callRpc('admin_list_people', listArgs({ p_limit: chunk, p_offset: offset }))
      rows.push(...data.rows)
      if (rows.length >= data.total || data.rows.length === 0) break
    }
    const columns = [
      { header: 'ID', value: (p) => p.label },
      { header: 'Full name', value: (p) => p.full_name },
      { header: 'Phone', value: (p) => p.phone },
      { header: 'Alternative phone', value: (p) => p.alt_phone || '' },
      { header: 'Email', value: (p) => p.email || '' },
      { header: 'Gender', value: (p) => p.gender || '' },
      { header: 'Membership type', value: (p) => membershipTypeLabel(p.membership_type) },
      { header: 'Residence', value: (p) => p.residence || '' },
      { header: 'Department', value: (p) => p.department || '' },
      { header: 'Deaconess', value: (p) => p.deaconess || '' },
      { header: 'Church', value: (p) => p.church_name || '' },
      { header: 'Membership date', value: (p) => (p.membership_date ? String(p.membership_date).slice(0, 10) : '') },
      { header: 'Status', value: (p) => p.status },
      { header: 'Needs review', value: (p) => (p.needs_review ? 'Yes' : '') },
      { header: 'Registrations', value: (p) => p.registrations },
      { header: 'Meetings attended (all time)', value: (p) => p.attended_total },
      { header: state.from || state.to ? 'Meetings attended in period' : 'Meetings attended (same)', value: (p) => p.attended_range },
      { header: 'Last attended', value: (p) => (p.last_attended ? String(p.last_attended).slice(0, 10) : '') },
    ]
    downloadFile(`${slug(MODE === 'member' ? 'members' : 'visitors')}.csv`, toCsv(columns, rows))
    toast(`Exported ${rows.length} ${noun()}(s)`)
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

// ---------------------------------------------------------------------------
// Add / edit / convert form
// ---------------------------------------------------------------------------
const FIELD_ERRORS = {
  invalid_name: 'full_name',
  invalid_phone: 'phone',
  invalid_alt_phone: 'alt_phone',
  invalid_email: 'email',
  invalid_gender: 'gender',
  invalid_type: 'membership_type',
  invalid_deaconess: 'deaconess_id',
  invalid_notes: 'notes',
  duplicate_phone: 'phone',
}

function showFormErrors(errors) {
  for (const field of $('#person-form').querySelectorAll('.field')) {
    const message = errors[field.dataset.field]
    field.classList.toggle('invalid', Boolean(message))
    const slot = field.querySelector('.error')
    if (slot) slot.textContent = message || ''
  }
}

function openForm(mode, person = null) {
  formMode = mode
  formPerson = person
  const form = $('#person-form')
  form.reset()
  showFormErrors({})
  $('#form-status').replaceChildren()
  $('#dup-box').replaceChildren()
  $('#convert-note').classList.toggle('hidden', mode !== 'convert')
  $('#review-box').classList.toggle('hidden', !(mode === 'edit' && person && person.needs_review))
  $('#p-review').checked = false

  $('#person-title').textContent = mode === 'create' ? 'Add member' : mode === 'convert' ? `Convert ${person.full_name} to a member` : `Edit ${person.full_name}`
  $('#person-submit').textContent = mode === 'create' ? 'Save member' : mode === 'convert' ? 'Convert to member' : 'Save changes'

  // The type list: a visitor is converted INTO a member type, so "Visitor" is not offered then.
  const typeSelect = $('#p-type')
  for (const option of typeSelect.options) option.hidden = mode === 'convert' && option.value === 'visitor'
  typeSelect.value = person ? (mode === 'convert' ? 'member' : person.membership_type || 'member') : 'member'
  fillDeaconessSelect(person ? person.deaconess_id : null)

  if (person) {
    form.full_name.value = person.full_name || ''
    form.phone.value = person.phone || ''
    form.alt_phone.value = person.alt_phone || ''
    form.email.value = person.email || ''
    form.gender.value = person.gender || ''
    form.church_name.value = person.church_name || ''
    form.department.value = person.department || ''
    form.residence.value = person.residence || ''
    form.membership_date.value = person.membership_date ? String(person.membership_date).slice(0, 10) : ''
    form.notes.value = person.notes || ''
  }
  $('#person-dialog').showModal()
  form.full_name.focus()
}

function readForm() {
  const f = $('#person-form')
  return {
    p_full_name: f.full_name.value.trim(),
    p_phone: f.phone.value.trim(),
    p_alt_phone: f.alt_phone.value.trim() || null,
    p_email: f.email.value.trim() || null,
    p_gender: f.gender.value || null,
    p_membership_date: f.membership_date.value || null,
    p_department: f.department.value.trim() || null,
    p_residence: f.residence.value.trim() || null,
    p_deaconess_id: f.deaconess_id.value || null,
    p_membership_type: f.membership_type.value || null,
    p_church: f.church_name.value.trim() || null,
    p_notes: f.notes.value.trim() || null,
  }
}

function matchList(matches, { allowForce }) {
  const reasonText = { same_phone: 'same phone number', same_email: 'same email', similar_name: 'similar name' }
  return el(
    'div',
    { class: 'notice notice-warning' },
    el('strong', {}, 'Please check before adding another record'),
    el(
      'ul',
      { class: 'dup-list' },
      ...matches.map((m) =>
        el(
          'li',
          {},
          el('strong', {}, m.full_name),
          ` (${m.label}, ${m.kind}${m.status === 'inactive' ? ', inactive' : ''}) · ${m.phone} · `,
          (m.reasons || []).map((r) => reasonText[r] || r).join(', '),
          ' ',
          el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => { $('#person-dialog').close(); openProfile(m.id) } }, 'Open record')
        )
      )
    ),
    allowForce
      ? el('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => submitForm(true) }, 'This is a different person: add anyway')
      : null
  )
}

// While typing: warn early when the name, phone or email looks like someone already registered.
const checkDuplicates = debounce(async () => {
  if (formMode !== 'create') return
  const a = readForm()
  if (a.p_full_name.length < 3 && a.p_phone.replace(/\D/g, '').length < 7) {
    $('#dup-box').replaceChildren()
    return
  }
  try {
    const data = await callRpc('admin_find_duplicates', {
      p_full_name: a.p_full_name,
      p_phone: a.p_phone || '000',
      p_alt_phone: a.p_alt_phone,
      p_email: a.p_email,
    })
    // The same phone number can never be added twice; a similar name or email can be, once reviewed.
    const blocked = data.matches.some((m) => (m.reasons || []).includes('same_phone'))
    $('#dup-box').replaceChildren(data.matches.length ? matchList(data.matches, { allowForce: !blocked }) : '')
  } catch {
    /* the warning is a convenience; saving checks again */
  }
}, 500)

async function submitForm(force = false) {
  const form = $('#person-form')
  const args = readForm()
  const errors = {}
  if (args.p_full_name.length < 2) errors.full_name = 'Enter the full name.'
  if (args.p_phone.replace(/\D/g, '').length < 9) errors.phone = 'Enter a valid phone number, for example 0712 345 678.'
  if (args.p_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.p_email)) errors.email = 'That email address does not look right.'
  showFormErrors(errors)
  if (Object.keys(errors).length) return

  const submit = $('#person-submit')
  submit.disabled = true
  $('#form-status').replaceChildren()
  try {
    let data
    if (formMode === 'create') {
      data = await rpcRaw('admin_create_member', { ...args, p_force: force })
    } else if (formMode === 'edit') {
      data = await rpcRaw('admin_update_person', { p_id: formPerson.id, ...args, p_clear_review: $('#p-review').checked })
    } else {
      data = await rpcRaw('admin_convert_visitor', { p_id: formPerson.id, ...args })
    }

    if (data && data.ok) {
      $('#person-dialog').close()
      toast(
        formMode === 'create' ? `${args.p_full_name} added as ${data.label}`
          : formMode === 'convert' ? `${args.p_full_name} is now a member (${data.label})`
          : 'Changes saved'
      )
      await Promise.all([loadPage(), refreshStats()])
      return
    }

    if (data && data.error === 'possible_duplicate') {
      $('#dup-box').replaceChildren(matchList(data.matches || [], { allowForce: true }))
      $('#dup-box').scrollIntoView({ block: 'nearest' })
    } else if (data && data.error === 'duplicate_phone') {
      showFormErrors({ phone: data.message })
      $('#dup-box').replaceChildren(matchList(data.existing ? [{ ...data.existing, reasons: ['same_phone'] }] : [], { allowForce: false }))
    } else if (data && FIELD_ERRORS[data.error]) {
      showFormErrors({ [FIELD_ERRORS[data.error]]: data.message })
    } else {
      notice($('#form-status'), (data && data.message) || 'Something went wrong. Please try again.', 'error')
    }
  } catch (e) {
    notice($('#form-status'), errorText(e), 'error')
  } finally {
    submit.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Profile: details, attendance history, totals per year
// ---------------------------------------------------------------------------
async function openProfile(id, year = null) {
  const body = $('#profile-body')
  body.replaceChildren(el('p', { class: 'muted' }, 'Loading…'))
  if (!$('#profile-dialog').open) $('#profile-dialog').showModal()
  let data
  try {
    data = await callRpc('admin_get_person', { p_id: id, p_year: year })
  } catch (e) {
    notice(body, errorText(e), 'error')
    return
  }
  profileYear = data.year
  const p = data.person
  $('#profile-title').textContent = p.full_name

  const facts = [
    ['ID', p.label],
    ['Phone', p.phone],
    ['Membership type', membershipTypeLabel(p.membership_type)],
    p.alt_phone ? ['Alternative phone', p.alt_phone] : null,
    p.residence ? ['Residence', p.residence] : null,
    p.department ? ['Department', p.department] : null,
    p.deaconess ? ['Deaconess', p.deaconess] : null,
    p.email ? ['Email', p.email] : null,
    p.gender ? ['Gender', p.gender] : null,
    p.church_name ? ['Church', p.church_name] : null,
    p.membership_date ? ['Member since', formatDate(String(p.membership_date).slice(0, 10))] : null,
    p.became_member_at ? ['Became a member', formatDateTime(p.became_member_at)] : null,
    p.notes ? ['Notes', p.notes] : null,
  ].filter(Boolean)

  const years = [...new Set([data.year, ...data.years.map((y) => y.year)])].sort((a, b) => b - a)
  const yearSelect = el(
    'select',
    { 'aria-label': 'Year', onchange: (e) => openProfile(id, Number(e.target.value)) },
    ...years.map((y) => el('option', { value: String(y), ...(y === data.year ? { selected: true } : {}) }, String(y)))
  )

  const history = data.history.length
    ? el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Event', 'Date', 'Was a', 'Checked in', 'Recorded by'].map((h) => el('th', {}, h)))),
        el(
          'tbody',
          {},
          ...data.history.map((h) =>
            el(
              'tr',
              {},
              el('td', {}, h.name, h.event_status === 'cancelled' ? el('span', { class: 'badge badge-error' }, 'Cancelled') : null),
              el('td', {}, formatDate(String(h.event_date).slice(0, 10))),
              el('td', {}, kindBadge(h.classification)),
              el('td', {}, formatDateTime(h.checked_in_at)),
              el('td', {}, h.recorded_by || '—')
            )
          )
        )
      )
    : el('p', { class: 'muted' }, 'No attendance recorded yet.')

  const regs = data.registrations.length
    ? el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Event', 'Date', 'Registered as', 'Registration', 'Attended'].map((h) => el('th', {}, h)))),
        el(
          'tbody',
          {},
          ...data.registrations.map((r) =>
            el(
              'tr',
              {},
              el('td', {}, r.name),
              el('td', {}, formatDate(String(r.event_date).slice(0, 10))),
              el('td', {}, kindBadge(r.classification)),
              el('td', {}, r.status === 'registered' ? 'Registered' : 'Cancelled'),
              el('td', {}, r.attended ? '✓' : '—')
            )
          )
        )
      )
    : el('p', { class: 'muted' }, 'Has not registered for any event.')

  setChildren(
    body,
    el(
      'div',
      { class: 'row-actions', style: 'margin-bottom:.75rem' },
      membershipBadge(p.membership_type),
      el('span', { class: `badge badge-${p.status === 'active' ? 'success' : 'muted'}` }, p.status === 'active' ? 'Active' : 'Inactive'),
      p.needs_review ? el('span', { class: 'badge badge-warning' }, 'Needs review') : null
    ),
    p.needs_review && p.review_note ? el('div', { class: 'notice notice-warning' }, p.review_note) : null,
    el('dl', { class: 'person-facts' }, ...facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    el(
      'div',
      { class: 'row-actions', style: 'margin:1rem 0' },
      el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => { $('#profile-dialog').close(); openForm('edit', p) } }, 'Edit'),
      p.kind === 'visitor'
        ? el('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => { $('#profile-dialog').close(); openForm('convert', p) } }, 'Convert to member')
        : null
    ),
    el(
      'div',
      { class: 'toolbar' },
      el('div', { class: 'field' }, el('label', {}, 'Year'), yearSelect),
      el('div', { class: 'stat' }, el('div', { class: 'value' }, String(data.year_total)), el('div', { class: 'label' }, `Meetings attended in ${data.year}`))
    ),
    el('h3', {}, 'Attendance history'),
    el('div', { class: 'table-wrap' }, history),
    el('h3', {}, 'Registrations'),
    el('div', { class: 'table-wrap' }, regs)
  )
}

// ---------------------------------------------------------------------------
export async function initPeople(mode) {
  MODE = mode === 'visitor' ? 'visitor' : 'member'
  const session = await requireAdmin(MODE === 'member' ? 'members' : 'visitors')
  if (!session) return

  for (const dialog of document.querySelectorAll('dialog')) {
    for (const b of dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => dialog.close())
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close()
    })
  }

  const reset = () => {
    state.page = 0
    loadPage()
  }
  $('#search').addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); reset() }, 300))
  $('#f-status').addEventListener('change', (e) => { state.status = e.target.value; reset() })
  $('#f-type').addEventListener('change', (e) => { state.type = e.target.value; reset() })
  $('#f-department').addEventListener('change', (e) => { state.department = e.target.value; reset() })
  $('#f-deaconess').addEventListener('change', (e) => { state.deaconess = e.target.value; reset() })
  $('#f-attended').addEventListener('change', (e) => { state.attended = e.target.value; reset() })
  $('#f-from').addEventListener('change', (e) => { state.from = e.target.value; reset() })
  $('#f-to').addEventListener('change', (e) => { state.to = e.target.value; reset() })
  $('#f-sort').addEventListener('change', (e) => { state.sort = e.target.value; reset() })
  $('#f-review').addEventListener('change', (e) => { state.review = e.target.checked; reset() })
  $('#f-repeat').addEventListener('change', (e) => { state.repeat = e.target.checked; reset() })
  $('#prev').addEventListener('click', () => { state.page = Math.max(0, state.page - 1); loadPage() })
  $('#next').addEventListener('click', () => { state.page += 1; loadPage() })
  $('#export').addEventListener('click', exportCsv)
  $('#add-person').addEventListener('click', () => openForm('create'))
  $('#person-form').addEventListener('submit', (e) => { e.preventDefault(); submitForm(false) })
  for (const id of ['#p-name', '#p-phone', '#p-alt', '#p-email']) $(id).addEventListener('input', checkDuplicates)

  // Members can be imported from a CSV file (the Visitors page has no import).
  if (MODE === 'member' && $('#import-btn')) {
    initImport({ onImported: () => Promise.all([loadPage(), refreshStats(), loadOptions()]) })
  }

  await Promise.all([loadPage(), refreshStats(), loadOptions()])
}

// The deaconess dropdown in the form: the active deaconesses, plus the person's current one
// even if she has been deactivated since, so editing never silently drops her.
let deaconesses = []
function fillDeaconessSelect(currentId) {
  const select = $('#p-deaconess')
  select.replaceChildren(
    el('option', { value: '' }, 'No deaconess assigned'),
    ...deaconesses
      .filter((d) => d.active || d.id === currentId)
      .map((d) => el('option', { value: d.id }, d.active ? d.name : `${d.name} (inactive)`))
  )
  select.value = currentId || ''
}

// Departments and residences already in use are offered as suggestions; the deaconess choices come from her list.
async function loadOptions() {
  try {
    const o = await callRpc('admin_person_options')
    const fill = (id, values) => $(id).replaceChildren(...values.map((v) => el('option', { value: v })))
    fill('#dl-department', o.departments)
    fill('#dl-residence', o.residences)
    const keepDept = $('#f-department').value
    $('#f-department').replaceChildren(el('option', { value: '' }, 'All departments'), ...o.departments.map((d) => el('option', { value: d }, d)))
    $('#f-department').value = keepDept
    // The deaconess list: filter choices on the page, and the choices in the form.
    const dl = await callRpc('admin_list_deaconesses')
    deaconesses = dl.rows
    $('#f-deaconess').replaceChildren(
      el('option', { value: '' }, 'All deaconesses'),
      ...deaconesses.map((d) => el('option', { value: d.id }, d.active ? d.name : `${d.name} (inactive)`))
    )
    // A link from the Deaconesses page (members.html?deaconess=...) opens already filtered.
    const wanted = new URLSearchParams(window.location.search).get('deaconess')
    if (wanted && deaconesses.some((d) => d.id === wanted)) {
      $('#f-deaconess').value = wanted
      state.deaconess = wanted
      state.page = 0
      await loadPage()
    }
  } catch {
    /* suggestions are a convenience */
  }
}
