// The list of deaconesses (administrators only). Members are assigned to one of these by
// choosing from the list, so names are spelled the same way everywhere and a deaconess's
// members can be found in one click.
import { supabase } from './supabase-client.js'
import { requireAdmin } from './admin-auth.js'
import { callRpc, errorText } from './admin-common.js'
import { el, $, notice, toast } from './ui.js'

let rows = []
let editing = null // the deaconess being edited, or null when adding

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
                ? el('a', { href: `members.html?deaconess=${d.id}` }, `${d.members} member${d.members === 1 ? '' : 's'}`)
                : '0'
            ),
            el('td', {}, el('span', { class: `badge badge-${d.active ? 'success' : 'muted'}` }, d.active ? 'Active' : 'Inactive')),
            el(
              'td',
              {},
              el(
                'div',
                { class: 'row-actions' },
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
  if (!active && !confirm(`Deactivate ${d.name}? She stays on the members she already mentors but will not be offered for new members.`)) return
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
    alert(`${d.name} mentors ${d.members} member${d.members === 1 ? '' : 's'}, so she cannot be removed. Move them to another deaconess first, or use Deactivate.`)
    return
  }
  if (!confirm(`Remove ${d.name} from the list?`)) return
  try {
    await callRpc('admin_delete_deaconess', { p_id: d.id })
    toast(`${d.name} removed`)
    await load()
  } catch (err) {
    toast(errorText(err), 'error')
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
  $('#dea-form').addEventListener('submit', save)
  await load()
}
