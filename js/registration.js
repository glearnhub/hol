// Participant registration form.
import { supabase, isConfigured } from './supabase-client.js'
import { renderPublicLayout } from './layout.js'
import {
  el, $, param, isUuid, formatDate, formatTimeRange, notice, notConfiguredNotice, validateRegistration,
  formatSchedule,
} from './ui.js'

const ERROR_FIELDS = {
  invalid_name: 'fullName',
  invalid_email: 'email',
  invalid_phone: 'phone',
  invalid_church: 'church',
  already_registered: 'email',
  consent_required: 'consent',
  phone_already_registered: 'phone',
}

function showFieldErrors(form, errors) {
  for (const field of form.querySelectorAll('.field')) {
    const key = field.dataset.field
    const message = errors[key]
    field.classList.toggle('invalid', Boolean(message))
    const slot = field.querySelector('.error')
    if (slot) slot.textContent = message || ''
  }
}

export async function initRegistration() {
  renderPublicLayout('events')
  const status = $('#status')
  const formWrap = $('#form-wrap')

  if (!isConfigured) {
    status.replaceChildren(notConfiguredNotice())
    return
  }

  const id = param('id')
  if (!isUuid(id)) {
    notice(status, 'We could not find that event.', 'error')
    return
  }

  const { data: ev, error } = await supabase.from('public_events').select('*').eq('id', id).maybeSingle()
  if (error || !ev) {
    notice(status, 'This event is not available for registration.', 'error')
    return
  }

  $('#event-summary').replaceChildren(
    el('h2', {}, ev.name),
    el('p', { class: 'muted' }, `${formatSchedule(ev)} · ${ev.venue}`)
  )

  if (ev.registration_state !== 'open') {
    const messages = {
      full: 'Sorry, this event is fully booked.',
      closed: 'Registration for this event has closed.',
      not_open: 'Registration for this event has not opened yet.',
      ended: 'This event has already taken place.',
    }
    notice(status, messages[ev.registration_state] || 'Registration is not available.', 'warning')
    return
  }

  formWrap.classList.remove('hidden')
  const form = $('#register-form')
  const submit = $('#submit-btn')

  // "Other" reveals a box for the name of the participant's church.
  form.church.addEventListener('change', () => {
    const other = form.church.value === '__other'
    $('#church-other-field').classList.toggle('hidden', !other)
    if (other) form.churchOther.focus()
    else form.churchOther.value = ''
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    status.replaceChildren()

    const other = form.church.value === '__other'
    const values = {
      fullName: form.fullName.value,
      email: form.email.value,
      phone: form.phone.value,
      church: other ? form.churchOther.value : form.church.value,
    }
    const errors = validateRegistration(values)
    // The church is a drop-down, so it has its own messages.
    delete errors.church
    if (!form.church.value) errors.church = 'Please choose your church.'
    else if (other && (values.church.trim().length < 2 || values.church.trim().length > 150)) {
      errors.churchOther = 'Please enter the name of your church.'
    }
    if (!form.consent.checked) errors.consent = 'Please tick the box to give your consent before registering.'
    showFieldErrors(form, errors)
    if (Object.keys(errors).length) return

    submit.disabled = true
    submit.textContent = 'Registering…'

    const { data, error: rpcError } = await supabase.rpc('register_participant', {
      p_event_id: ev.id,
      p_full_name: values.fullName,
      p_email: values.email.trim(),
      p_phone: values.phone,
      p_church_name: values.church,
      p_consent: form.consent.checked,
    })

    if (rpcError || !data) {
      notice(status, 'Something went wrong while registering. Please try again.', 'error')
    } else if (!data.ok) {
      const field = ERROR_FIELDS[data.error]
      if (field) showFieldErrors(form, { [field]: data.message })
      notice(status, data.message || 'We could not complete your registration.', 'error')
    } else {
      // Keep a private copy so the participant can find their QR code again on this device.
      try {
        const saved = JSON.parse(localStorage.getItem('hol:registrations') || '[]')
        saved.unshift({
          reference: data.registration_reference,
          token: data.qr_token,
          eventName: data.event.name,
          eventDate: data.event.event_date,
        })
        localStorage.setItem('hol:registrations', JSON.stringify(saved.slice(0, 20)))
      } catch {
        /* private browsing: the link on the next page still works */
      }
      // The secret goes in the URL fragment, which is never sent to any server.
      window.location.href =
        `confirmation.html?ref=${encodeURIComponent(data.registration_reference)}` +
        `#t=${encodeURIComponent(data.qr_token)}`
      return
    }

    submit.disabled = false
    submit.textContent = 'Complete registration'
  })
}
