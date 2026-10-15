// Create, edit, publish, cancel events; upload posters; manage volunteer check-in links.
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm'
import { supabase } from './supabase-client.js'
import { requireAdmin } from './admin-auth.js'
import { POSTER_BUCKET, posterUrls } from './posters.js'
import { callRpc, eventStatusBadge, errorText } from './admin-common.js'
import { el, $, param, formatDate, formatTimeRange, formatSchedule, formatDateTime, notice, toast } from './ui.js'

const MAX_POSTER_BYTES = 2 * 1024 * 1024
const POSTER_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

let events = []
let counts = new Map()
let editing = null // the event being edited, or null when creating
let linksEventId = null

// ---------------------------------------------------------------------------
// Event list
// ---------------------------------------------------------------------------
async function loadEvents() {
  const status = $('#status')
  try {
    const [{ data, error }, overview] = await Promise.all([
      supabase.from('events').select('*').order('event_date', { ascending: false }).order('start_time', { ascending: false }),
      callRpc('admin_reports_overview'),
    ])
    if (error) throw error
    events = data || []
    counts = new Map((overview.events || []).map((e) => [e.event_id, e]))
    renderEvents()
  } catch (e) {
    notice(status, errorText(e), 'error')
  }
}

function renderEvents() {
  const host = $('#events')
  if (events.length === 0) {
    host.replaceChildren(el('p', { class: 'muted' }, 'No events yet. Click "New event" to create one.'))
    return
  }

  const rows = events.map((ev) => {
    const c = counts.get(ev.id) || { registrations: 0, attendees: 0 }
    const actions = el(
      'div',
      { class: 'row-actions' },
      el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => openEventForm(ev) }, 'Edit'),
      el('a', { class: 'btn btn-outline btn-small', href: `event-registrations.html?id=${ev.id}` }, 'Registrations'),
      el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => openLinks(ev) }, 'Check-in links'),
      ev.status === 'published'
        ? el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => setStatus(ev, 'draft') }, 'Unpublish')
        : null,
      ev.status === 'draft'
        ? el('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => setStatus(ev, 'published') }, 'Publish')
        : null,
      ev.status !== 'cancelled'
        ? el('button', { class: 'btn btn-danger btn-small', type: 'button', onclick: () => cancelEvent(ev) }, 'Cancel event')
        : el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => setStatus(ev, 'draft') }, 'Restore as draft')
    )
    return el(
      'tr',
      {},
      el('td', {}, el('strong', {}, ev.name), el('div', { class: 'muted' }, ev.venue)),
      el('td', {}, formatDate(ev.event_date), el('div', { class: 'muted' }, formatSchedule(ev).slice(formatDate(ev.event_date).length).replace(/^[ ,·]+/, ''))),
      el('td', {}, eventStatusBadge(ev.status)),
      el('td', {}, `${c.registrations} / ${ev.capacity}`, el('div', { class: 'muted' }, `${c.attendees} attended`)),
      el('td', {}, actions)
    )
  })

  host.replaceChildren(
    el(
      'table',
      { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Event', 'When', 'Status', 'Registered', 'Actions'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows)
    )
  )
}

async function setStatus(ev, status) {
  const { error } = await supabase.from('events').update({ status }).eq('id', ev.id)
  if (error) {
    toast(errorText(error), 'error')
    return
  }
  toast(status === 'published' ? 'Event published' : status === 'draft' ? 'Event moved to drafts' : 'Event updated')
  await loadEvents()
}

async function cancelEvent(ev) {
  const c = counts.get(ev.id)
  const people = c && c.registrations ? ` ${c.registrations} registered participant(s) will see that it is cancelled.` : ''
  if (!confirm(`Cancel "${ev.name}"? It will disappear from the public site and registration will close.${people}`)) return
  await setStatus(ev, 'cancelled')
}

let currentPosterUrl = null
let previewObjectUrl = null

// Shows (or hides) the poster preview in the event form.
function setPosterPreview(url) {
  const box = $('#poster-preview')
  if (previewObjectUrl && url !== previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl)
    previewObjectUrl = null
  }
  if (!url) {
    box.classList.add('hidden')
    return
  }
  box.querySelector('img').src = url
  box.classList.remove('hidden')
}

// ---------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------
function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function showFormErrors(form, errors) {
  for (const field of form.querySelectorAll('.field')) {
    const message = errors[field.dataset.field]
    field.classList.toggle('invalid', Boolean(message))
    const slot = field.querySelector('.error')
    if (slot) slot.textContent = message || ''
  }
}

function openEventForm(ev = null) {
  editing = ev
  const form = $('#event-form')
  form.reset()
  showFormErrors(form, {})
  $('#form-status').replaceChildren()
  $('#event-dialog-title').textContent = ev ? 'Edit event' : 'New event'

  if (ev) {
    form.event_name.value = ev.name
    form.description.value = ev.description || ''
    form.venue.value = ev.venue
    form.event_date.value = String(ev.event_date).slice(0, 10)
    form.start_time.value = (ev.start_time || '').slice(0, 5)
    form.end_date.value = ev.end_date ? String(ev.end_date).slice(0, 10) : ''
    form.end_time.value = (ev.end_time || '').slice(0, 5)
    form.capacity.value = ev.capacity
    form.show_remaining.value = String(ev.show_remaining)
    form.registration_opens_at.value = toLocalInput(ev.registration_opens_at)
    form.registration_closes_at.value = toLocalInput(ev.registration_closes_at)
  }

  // Show the poster that is already saved (if any), so the admin sees how it fits.
  currentPosterUrl = null
  setPosterPreview(null)
  if (ev && ev.poster_path) {
    $('#poster-current').textContent = 'A poster is already uploaded. Choose a file to replace it.'
    posterUrls([ev.poster_path]).then((urls) => {
      currentPosterUrl = urls.get(ev.poster_path) || null
      // Only apply it if the same event form is still open.
      if (editing && editing.id === ev.id && !$('#f-poster').files[0]) setPosterPreview(currentPosterUrl)
    })
  } else {
    $('#poster-current').textContent = 'Best results: a portrait or square image at least 1000 px wide.'
  }
  // Existing events keep their status here; publish/unpublish/cancel live on the list.
  $('#save-publish').classList.toggle('hidden', Boolean(ev))
  $('#save-draft').textContent = ev ? 'Save changes' : 'Save as draft'
  $('#save-draft').dataset.status = ev ? 'keep' : 'draft'
  $('#event-dialog').showModal()
}

function readForm(form) {
  const num = (v) => (v === '' ? NaN : Number(v))
  return {
    name: form.event_name.value.trim(),
    description: form.description.value.trim(),
    venue: form.venue.value.trim(),
    event_date: form.event_date.value,
    start_time: form.start_time.value,
    end_date: form.end_date.value || null,
    end_time: form.end_time.value || null,
    capacity: num(form.capacity.value),
    show_remaining: form.show_remaining.value === 'true',
    opens: form.registration_opens_at.value ? new Date(form.registration_opens_at.value) : null,
    closes: form.registration_closes_at.value ? new Date(form.registration_closes_at.value) : null,
    file: form.poster.files[0] || null,
  }
}

function validate(v) {
  const errors = {}
  if (v.name.length < 3 || v.name.length > 150) errors.name = 'Enter an event name (3 to 150 characters).'
  if (v.venue.length < 2 || v.venue.length > 200) errors.venue = 'Enter the venue.'
  if (!v.event_date) errors.event_date = 'Choose the event date.'
  if (!v.start_time) errors.start_time = 'Choose a start time.'
  if (v.end_date && v.event_date && v.end_date < v.event_date) {
    errors.end_date = 'The end date cannot be before the event date.'
  } else if (v.end_time && v.start_time && (v.end_date || v.event_date) === v.event_date && v.end_time <= v.start_time) {
    errors.end_time = 'End time must be after the start time, or choose a later end date.'
  } else if (v.end_date && v.end_date !== v.event_date && !v.end_time) {
    errors.end_time = 'Choose the time the event ends on the end date.'
  }
  if (!Number.isInteger(v.capacity) || v.capacity < 1) errors.capacity = 'Capacity must be a whole number of at least 1.'
  if (v.opens && v.closes && v.closes <= v.opens) errors.registration_closes_at = 'Registration must close after it opens.'
  if (v.closes && v.event_date && v.start_time) {
    const lastDay = v.end_date || v.event_date
    const eventEnd = new Date(`${lastDay}T${v.end_time || '23:59'}`)
    if (v.closes > new Date(eventEnd.getTime() + 3600 * 1000)) {
      errors.registration_closes_at = 'Registration should close by the time the event ends.'
    }
  }
  if (v.file) {
    if (!POSTER_TYPES[v.file.type]) errors.poster = 'The poster must be a JPG, PNG or WebP image.'
    else if (v.file.size > MAX_POSTER_BYTES) errors.poster = 'The poster must be 2 MB or smaller.'
  }
  return errors
}

async function saveEvent(statusChoice) {
  const form = $('#event-form')
  const v = readForm(form)
  const errors = validate(v)
  showFormErrors(form, errors)
  if (Object.keys(errors).length) return

  const buttons = form.querySelectorAll('button[type=submit]')
  buttons.forEach((b) => (b.disabled = true))
  const formStatus = $('#form-status')
  formStatus.replaceChildren()

  let uploadedPath = null
  try {
    let posterPath = editing ? editing.poster_path : null

    if (v.file) {
      const ext = POSTER_TYPES[v.file.type]
      uploadedPath = `posters/${crypto.randomUUID()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from(POSTER_BUCKET)
        .upload(uploadedPath, v.file, { contentType: v.file.type, upsert: false, cacheControl: '3600' })
      if (upErr) throw upErr
      posterPath = uploadedPath
    }

    const payload = {
      name: v.name,
      description: v.description,
      venue: v.venue,
      event_date: v.event_date,
      start_time: v.start_time,
      end_date: v.end_date,
      end_time: v.end_time,
      capacity: v.capacity,
      show_remaining: v.show_remaining,
      registration_opens_at: v.opens ? v.opens.toISOString() : null,
      registration_closes_at: v.closes ? v.closes.toISOString() : null,
      poster_path: posterPath,
    }
    if (statusChoice !== 'keep') payload.status = statusChoice

    const { error } = editing
      ? await supabase.from('events').update(payload).eq('id', editing.id)
      : await supabase.from('events').insert(payload)
    if (error) throw error

    // The new poster is safely saved; remove the one it replaced.
    if (uploadedPath && editing && editing.poster_path && editing.poster_path !== uploadedPath) {
      await supabase.storage.from(POSTER_BUCKET).remove([editing.poster_path])
    }

    $('#event-dialog').close()
    toast(editing ? 'Event updated' : statusChoice === 'published' ? 'Event created and published' : 'Draft saved')
    await loadEvents()
  } catch (e) {
    // Do not leave an orphaned upload behind if the event itself failed to save.
    if (uploadedPath) await supabase.storage.from(POSTER_BUCKET).remove([uploadedPath])
    const message = /cannot be lower/i.test(e.message || '')
      ? e.message
      : errorText(e)
    notice(formStatus, message, 'error')
  } finally {
    buttons.forEach((b) => (b.disabled = false))
  }
}

// ---------------------------------------------------------------------------
// Volunteer check-in links
// ---------------------------------------------------------------------------
function checkInUrl(token) {
  return new URL('check-in.html', window.location.href).href + '#' + token
}

async function openLinks(ev) {
  linksEventId = ev.id
  $('#links-title').textContent = `Check-in links: ${ev.name}`
  $('#new-link').replaceChildren()
  $('#links-status').replaceChildren()
  $('#links-dialog').showModal()
  await loadLinks()
}

async function loadLinks() {
  const host = $('#links-list')
  const { data, error } = await supabase
    .from('volunteer_access')
    .select('id, label, expires_at, revoked_at, last_used_at, created_at')
    .eq('event_id', linksEventId)
    .order('created_at', { ascending: false })

  if (error) {
    notice($('#links-status'), errorText(error), 'error')
    return
  }
  if (!data.length) {
    host.replaceChildren(el('p', { class: 'muted' }, 'No links yet. Create one above.'))
    return
  }

  const now = Date.now()
  host.replaceChildren(
    el(
      'table',
      { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Label', 'Status', 'Expires', 'Last used', ''].map((h) => el('th', {}, h)))),
      el(
        'tbody',
        {},
        ...data.map((l) => {
          const revoked = Boolean(l.revoked_at)
          const expired = new Date(l.expires_at).getTime() <= now
          const badge = revoked
            ? el('span', { class: 'badge badge-error' }, 'Revoked')
            : expired
              ? el('span', { class: 'badge badge-muted' }, 'Expired')
              : el('span', { class: 'badge badge-success' }, 'Active')
          return el(
            'tr',
            {},
            el('td', {}, l.label),
            el('td', {}, badge),
            el('td', {}, formatDateTime(l.expires_at)),
            el('td', {}, l.last_used_at ? formatDateTime(l.last_used_at) : 'Never'),
            el(
              'td',
              {},
              el(
                'div',
                { class: 'row-actions' },
                el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: () => regenerate(l) }, 'New link'),
                !revoked
                  ? el('button', { class: 'btn btn-danger btn-small', type: 'button', onclick: () => revoke(l) }, 'Revoke')
                  : null
              )
            )
          )
        })
      )
    )
  )
}

async function showNewLink(result, label) {
  const url = checkInUrl(result.token)
  const canvas = el('canvas', { width: 180, height: 180, 'aria-label': 'QR code of the check-in link' })
  await QRCode.toCanvas(canvas, url, { width: 180, margin: 1, color: { dark: '#600086', light: '#FFFFFF' } })

  $('#new-link').replaceChildren(
    el(
      'div',
      { class: 'notice notice-success' },
      el('strong', {}, `Link created for "${label}". `),
      'Copy it now: for security it cannot be shown again.',
      el('div', { class: 'link-box', style: 'margin:.75rem 0' }, url),
      el(
        'div',
        { class: 'row-actions' },
        el(
          'button',
          {
            class: 'btn btn-primary btn-small',
            type: 'button',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(url)
                toast('Link copied')
              } catch {
                toast('Select the link and copy it manually', 'error')
              }
            },
          },
          'Copy link'
        )
      ),
      el('p', { class: 'muted', style: 'margin:.75rem 0 .25rem' }, 'Or scan this with the volunteer\'s phone:'),
      canvas
    )
  )
}

async function createLink(e) {
  e.preventDefault()
  const label = $('#l-label').value.trim()
  const days = Number($('#l-days').value)
  const status = $('#links-status')
  if (!label) {
    notice(status, 'Give the link a short label, for example "Main door".', 'error')
    return
  }
  try {
    const expires = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString()
    const result = await callRpc('admin_create_volunteer_link', {
      p_event_id: linksEventId,
      p_label: label,
      p_expires_at: expires,
    })
    status.replaceChildren()
    $('#l-label').value = ''
    await showNewLink(result, label)
    await loadLinks()
  } catch (err) {
    notice(status, errorText(err), 'error')
  }
}

async function revoke(link) {
  if (!confirm(`Revoke the "${link.label}" link? Anyone using it will be locked out immediately.`)) return
  try {
    await callRpc('admin_revoke_volunteer_link', { p_access_id: link.id })
    toast('Link revoked')
    await loadLinks()
  } catch (err) {
    notice($('#links-status'), errorText(err), 'error')
  }
}

async function regenerate(link) {
  if (!confirm(`Create a new link for "${link.label}"? The old one will stop working.`)) return
  try {
    const expires = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString()
    const result = await callRpc('admin_regenerate_volunteer_link', { p_access_id: link.id, p_expires_at: expires })
    await showNewLink(result, link.label)
    await loadLinks()
  } catch (err) {
    notice($('#links-status'), errorText(err), 'error')
  }
}

// ---------------------------------------------------------------------------
export async function initManageEvents() {
  const session = await requireAdmin('events')
  if (!session) return

  $('#new-event').addEventListener('click', () => openEventForm(null))
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close())
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close()
    })
  }

  // Preview a newly chosen poster straight away.
  $('#f-poster').addEventListener('change', (e) => {
    const file = e.target.files[0]
    if (file && POSTER_TYPES[file.type] && file.size <= MAX_POSTER_BYTES) {
      previewObjectUrl = URL.createObjectURL(file)
      setPosterPreview(previewObjectUrl)
    } else {
      setPosterPreview(file ? null : currentPosterUrl)
    }
  })

  $('#event-form').addEventListener('submit', (e) => {
    e.preventDefault()
    saveEvent(e.submitter?.dataset.status || 'keep')
  })
  $('#link-form').addEventListener('submit', createLink)

  await loadEvents()
  if (param('new')) openEventForm(null)
}
