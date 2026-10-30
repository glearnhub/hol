// The list of deaconesses (administrators only). Members are assigned to one of these by
// choosing from the list, so names are spelled the same way everywhere and a deaconess's
// members can be found in one click.
import { supabase } from './supabase-client.js'
import { requireAdmin } from './admin-auth.js'
import { callRpc, errorText, membershipBadge } from './admin-common.js'
import { el, $, setChildren, notice, toast, debounce, confirmDialog, alertDialog } from './ui.js'

let rows = []
let editing = null // the deaconess being edited, or null when adding
let current = null // the deaconess whose mentees are open
let mentees = [] // her mentees
let moving = null // the mentee being re-assigned

const label = (d) => `${d.name}${d.group_name ? ` — ${d.group_name}` : ''}`

function statCard(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label))
}

async function load() {
  try {
    const data = await callRpc('admin_list_deaconesses')
    rows = data.rows
    $('#status').replaceChildren()
    render()
  } catch (e) {
    notice($('#status'), errorText(e), 'error')
  }
}

function render() {
  const active = rows.filter((r) => r.active).length
  const assigned = rows.reduce((n, r) => n + r.members, 0)
  $('#stats').replaceChildren(
    statCard(rows.length, 'Deaconesses'),
    statCard(active, 'Active'),
    statCard(assigned, 'Members being mentored')
  )

  const host = $('#table')
  if (rows.length === 0) {
    host.replaceChildren(el('p', { class: 'muted' }, 'No deaconesses yet. Click "Add deaconess" to start the list.'))
    return
  }
  host.replaceChildren(
    el(
      'table',
      { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Deaconess', 'Group', 'Phone', 'Members mentored', 'Status', ''].map((h) => el('th', {}, h)))),
      el(
        'tbody',
        {},
        ...rows.map((d) =>
          el(
            'tr',
            {},
            el('td', {}, el('strong', {}, d.name)),
            el('td', {}, d.group_name ? el('strong', {}, d.group_name) : el('span', { class: 'muted' }, 'No group name')),
            el('td', {}, d.phone || '—'),
            el(
              'td',
              {},
              d.members
                ? el('a', { href: '#', onclick: (e) => { e.preventDefault(); openMentees(d) } }, `${d.members} mentee${d.members === 1 ? '' : 's'}`)
                : '0'
            ),
            el('td', {}, el('span', { class: `badge badge-${d.active ? 'success' : 'muted'}` }, d.active ? 'Active' : 'Inactive')),
            el(
              'td',
              {},
              el(
                'div',
                { class: 'row-actions' },
                el('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => openMentees(d) }, 'View mentees'),
                el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => openForm(d) }, 'Edit'),
                el(
                  'button',
                  { class: 'btn btn-outline btn-small', type: 'button', onclick: () => setActive(d, !d.active) },
                  d.active ? 'Deactivate' : 'Activate'
                ),
                el('button', { class: 'btn btn-danger btn-small', type: 'button', onclick: () => remove(d) }, 'Remove')
              )
            )
          )
        )
      )
    )
  )
}

function showErrors(errors) {
  for (const field of $('#dea-form').querySelectorAll('.field')) {
    const message = errors[field.dataset.field]
    field.classList.toggle('invalid', Boolean(message))
    const slot = field.querySelector('.error')
    if (slot) slot.textContent = message || ''
  }
}

function openForm(d = null) {
  editing = d
  const form = $('#dea-form')
  form.reset()
  showErrors({})
  $('#form-status').replaceChildren()
  $('#dea-title').textContent = d ? `Edit ${d.name}` : 'Add deaconess'
  $('#dea-submit').textContent = d ? 'Save changes' : 'Save deaconess'
  if (d) {
    form.name.value = d.name
    form.group_name.value = d.group_name || ''
    form.phone.value = d.phone || ''
    form.active.checked = d.active
  }
  $('#dea-dialog').showModal()
  form.name.focus()
}

async function save(e) {
  e.preventDefault()
  const form = $('#dea-form')
  const name = form.name.value.trim()
  if (name.length < 2) return showErrors({ name: 'Enter the deaconess\'s name.' })
  showErrors({})

  const submit = $('#dea-submit')
  submit.disabled = true
  try {
    const { data, error } = await supabase.rpc('admin_save_deaconess', {
      p_name: name,
      p_group_name: form.group_name.value.trim() || null,
      p_phone: form.phone.value.trim() || null,
      p_id: editing ? editing.id : null,
      p_active: form.active.checked,
    })
    if (error) throw new Error(error.message)
    if (!data.ok) {
      if (data.error === 'duplicate_name' || data.error === 'invalid_name') showErrors({ name: data.message })
      else if (data.error === 'invalid_phone') showErrors({ phone: data.message })
      else notice($('#form-status'), data.message || 'Something went wrong.', 'error')
      return
    }
    $('#dea-dialog').close()
    toast(editing ? 'Changes saved' : `${name} added to the list`)
    await load()
  } catch (err) {
    notice($('#form-status'), errorText(err), 'error')
  } finally {
    submit.disabled = false
  }
}

async function setActive(d, active) {
  if (!active && !(await confirmDialog('She stays on the members she already mentors but will not be offered for new members.', { title: `Deactivate ${d.name}?`, confirmLabel: 'Deactivate', danger: true }))) return
  try {
    await callRpc('admin_save_deaconess', { p_name: d.name, p_group_name: d.group_name, p_phone: d.phone, p_id: d.id, p_active: active })
    toast(active ? `${d.name} is active again` : `${d.name} deactivated`)
    await load()
  } catch (err) {
    toast(errorText(err), 'error')
  }
}

async function remove(d) {
  if (d.members > 0) {
    await alertDialog(`${d.name} mentors ${d.members} member${d.members === 1 ? '' : 's'}, so she cannot be removed. Move them to another deaconess first, or use Deactivate.`, { title: 'She cannot be removed yet' })
    return
  }
  if (!(await confirmDialog('She will no longer be in the list of deaconesses.', { title: `Remove ${d.name}?`, confirmLabel: 'Remove', danger: true }))) return
  try {
    await callRpc('admin_delete_deaconess', { p_id: d.id })
    toast(`${d.name} removed`)
    await load()
  } catch (err) {
    toast(errorText(err), 'error')
  }
}

// ---------------------------------------------------------------------------
// Mentees: the members a deaconess mentors
// ---------------------------------------------------------------------------
async function openMentees(d) {
  current = rows.find((r) => r.id === d.id) || d
  $('#mentees-title').textContent = label(current)
  $('#mentees-status').replaceChildren()
  $('#add-mentee').classList.toggle('hidden', !current.active)
  $('#mentees-dialog').showModal()
  await loadMentees()
}

async function loadMentees() {
  const host = $('#mentees-table')
  try {
    const data = await callRpc('admin_list_people', { p_kind: 'member', p_deaconess_id: current.id, p_limit: 500, p_offset: 0, p_sort: 'name_asc' })
    mentees = data.rows
  } catch (e) {
    notice($('#mentees-status'), errorText(e), 'error')
    return
  }
  $('#mentees-summary').textContent = mentees.length
    ? `${mentees.length} mentee${mentees.length === 1 ? '' : 's'}${current.active ? '' : ' (this deaconess is inactive, so she cannot be given new mentees)'}`
    : 'No mentees yet. Click "Add mentee" to give her someone to mentor.'
  if (mentees.length === 0) {
    host.replaceChildren()
    return
  }
  host.replaceChildren(
    el(
      'table',
      { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Mentee', 'Phone', 'Membership type', 'Status', ''].map((h) => el('th', {}, h)))),
      el(
        'tbody',
        {},
        ...mentees.map((m) =>
          el(
            'tr',
            {},
            el('td', {}, el('strong', {}, m.full_name), el('div', { class: 'muted' }, m.label)),
            el('td', {}, m.phone),
            el('td', {}, membershipBadge(m.membership_type)),
            el('td', {}, el('span', { class: `badge badge-${m.status === 'active' ? 'success' : 'muted'}` }, m.status === 'active' ? 'Active' : 'Inactive')),
            el(
              'td',
              {},
              el(
                'div',
                { class: 'row-actions' },
                el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => openReassign(m) }, 'Re-assign'),
                el('button', { class: 'btn btn-danger btn-small', type: 'button', onclick: () => removeMentee(m) }, 'Remove')
              )
            )
          )
        )
      )
    )
  )
}

// After any change: the open list, and the counts on the page behind it.
async function refreshAll() {
  await load()
  if (current) {
    current = rows.find((r) => r.id === current.id) || current
    if ($('#mentees-dialog').open) await loadMentees()
  }
}

async function removeMentee(m) {
  if (!(await confirmDialog(`${m.full_name} stays a member, just without a deaconess.`, { title: `Remove ${m.full_name} from ${current.name}?`, confirmLabel: 'Remove', danger: true }))) return
  try {
    await callRpc('admin_assign_deaconess', { p_person_ids: [m.id], p_deaconess_id: null })
    toast(`${m.full_name} removed from ${current.name}`)
    await refreshAll()
  } catch (e) {
    notice($('#mentees-status'), errorText(e), 'error')
  }
}

function openReassign(m) {
  moving = m
  const others = rows.filter((r) => r.active && r.id !== current.id)
  if (others.length === 0) {
    notice($('#mentees-status'), 'There is no other active deaconess to move her to. Add one first.', 'warning')
    return
  }
  $('#reassign-text').textContent = `${m.full_name} is mentored by ${label(current)}. Choose the deaconess who will mentor her instead.`
  $('#reassign-status').replaceChildren()
  $('#reassign-to').replaceChildren(...others.map((o) => el('option', { value: o.id }, label(o))))
  $('#reassign-dialog').showModal()
}

async function reassign(e) {
  e.preventDefault()
  const target = rows.find((r) => r.id === $('#reassign-to').value)
  const button = $('#reassign-go')
  button.disabled = true
  try {
    await callRpc('admin_assign_deaconess', { p_person_ids: [moving.id], p_deaconess_id: target.id })
    $('#reassign-dialog').close()
    toast(`${moving.full_name} moved to ${target.name}`)
    await refreshAll()
  } catch (err) {
    notice($('#reassign-status'), errorText(err), 'error')
  } finally {
    button.disabled = false
  }
}

// Add a mentee: find a member and give her to this deaconess
function openAddMentee() {
  $('#add-mentee-title').textContent = `Add a mentee to ${label(current)}`
  $('#mentee-search').value = ''
  $('#mentee-results').replaceChildren()
  $('#add-mentee-dialog').showModal()
  $('#mentee-search').focus()
}

async function searchMembers() {
  const q = $('#mentee-search').value.trim()
  const host = $('#mentee-results')
  if (q.length < 3) {
    host.replaceChildren()
    return
  }
  try {
    const data = await callRpc('admin_list_people', { p_kind: 'member', p_search: q, p_status: 'active', p_limit: 15, p_offset: 0 })
    if (data.rows.length === 0) {
      host.replaceChildren(el('p', { class: 'muted' }, 'Nobody found. Check the spelling, or register her under Members first.'))
      return
    }
    const byId = new Map(rows.map((r) => [r.id, r]))
    host.replaceChildren(
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Member', 'Phone', 'Her deaconess now', ''].map((h) => el('th', {}, h)))),
        el(
          'tbody',
          {},
          ...data.rows.map((m) => {
            const mine = m.deaconess_id === current.id
            const other = m.deaconess_id && !mine ? byId.get(m.deaconess_id) || { name: m.deaconess } : null
            return el(
              'tr',
              {},
              el('td', {}, el('strong', {}, m.full_name), el('div', { class: 'muted' }, m.label)),
              el('td', {}, m.phone),
              el('td', {}, mine ? el('span', { class: 'badge badge-success' }, 'Already her mentee') : other ? other.name : el('span', { class: 'muted' }, 'None')),
              el(
                'td',
                {},
                mine
                  ? null
                  : el('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => addMentee(m, other) }, other ? 'Move to her' : 'Add as mentee')
              )
            )
          })
        )
      )
    )
  } catch (e) {
    notice(host, errorText(e), 'error')
  }
}

async function addMentee(m, other) {
  if (other && !(await confirmDialog(`${m.full_name} is mentored by ${other.name}.`, { title: `Move her to ${current.name}?`, confirmLabel: 'Move her' }))) return
  try {
    await callRpc('admin_assign_deaconess', { p_person_ids: [m.id], p_deaconess_id: current.id })
    toast(`${m.full_name} added to ${current.name}`)
    await refreshAll()
    await searchMembers()
  } catch (e) {
    notice($('#mentee-results'), errorText(e), 'error')
  }
}

export async function initDeaconesses() {
  const session = await requireAdmin('deaconesses')
  if (!session) return

  for (const dialog of document.querySelectorAll('dialog')) {
    for (const b of dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => dialog.close())
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close()
    })
  }
  $('#add-deaconess').addEventListener('click', () => openForm(null))
  $('#add-mentee').addEventListener('click', openAddMentee)
  $('#reassign-form').addEventListener('submit', reassign)
  $('#mentee-search').addEventListener('input', debounce(searchMembers, 300))
  $('#dea-form').addEventListener('submit', save)
  await load()
}
