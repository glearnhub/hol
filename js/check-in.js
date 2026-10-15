// Volunteer check-in. No login: the secret in the page address (after the #) is the
// volunteer's event-specific credential. Every call goes through a narrow database
// function that only ever reaches that single event.
import { createAnonymousClient, isConfigured } from './supabase-client.js'
import {
  el, $, formatDate, formatTimeRange, formatDateTime, debounce, notConfiguredNotice, CHECKIN_ERRORS,
  formatSchedule,
} from './ui.js'

const db = createAnonymousClient()
const token = decodeURIComponent(window.location.hash.replace(/^#t=|^#/, '')).trim()

const status = $('#status')
const result = $('#result')
let scanner = null
let scanning = false
let busy = false
let lastCode = { value: '', at: 0 }

// ---------------------------------------------------------------------------
function showResult(kind, title, detail = '') {
  result.className = `ci-result ${kind}`
  result.replaceChildren(el('strong', {}, title), detail)
  result.classList.remove('hidden')
  if (kind === 'success') navigator.vibrate?.(120)
  if (kind === 'error') navigator.vibrate?.([80, 60, 80])
}

function explain(data, error) {
  if (error) return 'We could not reach the server. Check your connection and try again.'
  return data?.message || CHECKIN_ERRORS[data?.error] || 'Something went wrong. Please try again.'
}

// Fatal problems with the link itself: stop everything and explain.
function lockOut(message) {
  stopCamera()
  $('#app').classList.add('hidden')
  status.replaceChildren(el('div', { class: 'notice notice-error' }, message))
}

async function call(fn, args) {
  const { data, error } = await db.rpc(fn, args)
  return { data, error }
}

function applyOutcome(data, error, successText) {
  if (error || !data) {
    showResult('error', 'Not checked in', explain(data, error))
    return false
  }
  if (!data.ok) {
    if (['invalid_access', 'revoked', 'expired', 'event_unavailable'].includes(data.error)) {
      lockOut(explain(data))
      return false
    }
    showResult('error', 'Not checked in', explain(data))
    return false
  }
  if (data.result === 'already_checked_in') {
    showResult('duplicate', 'Already checked in', `${data.full_name} checked in at ${formatDateTime(data.checked_in_at)}.`)
    return true
  }
  showResult('success', successText || 'Checked in', `${data.full_name} is now marked present.`)
  return true
}

// ---------------------------------------------------------------------------
// Event header and counters
// ---------------------------------------------------------------------------
async function loadEvent(first = false) {
  const { data, error } = await call('volunteer_event', { p_token: token })
  if (error || !data || !data.ok) {
    lockOut(explain(data, error))
    return false
  }
  $('#event-name').textContent = data.event.name
  $('#event-meta').textContent =
    `${formatSchedule(data.event)} · ${data.event.venue}`
  $('#counts').textContent = `${data.checked_in} of ${data.registered} checked in`
  if (first) {
    status.replaceChildren()
    $('#app').classList.remove('hidden')
  }
  return true
}

// ---------------------------------------------------------------------------
// QR scanning
// ---------------------------------------------------------------------------
async function handleCode(code) {
  const now = Date.now()
  if (busy || (code === lastCode.value && now - lastCode.at < 4000)) return
  lastCode = { value: code, at: now }
  busy = true
  try {
    const { data, error } = await call('volunteer_check_in_qr', { p_token: token, p_code: code })
    if (applyOutcome(data, error, 'Checked in')) await loadEvent()
  } finally {
    busy = false
  }
}

// Built-in browsers inside apps (WhatsApp, Facebook, Instagram...) usually block
// the camera. Detecting them lets us tell the volunteer exactly what to do.
function inAppBrowser() {
  const ua = navigator.userAgent || ''
  if (['FBAN', 'FBAV', 'FB_IAB', 'Instagram', 'MicroMessenger', 'Snapchat', 'WhatsApp'].some((k) => ua.includes(k))) {
    return true
  }
  if (ua.includes('; wv)')) return true // Android WebView
  const ios = ua.includes('iPhone') || ua.includes('iPad') || ua.includes('iPod')
  return ios && !ua.includes('Safari') // iOS web views leave out the Safari token
}

function showHelp(message, { copyLink = false } = {}) {
  const box = $('#camera-help')
  const parts = [el('div', {}, message)]
  if (copyLink) {
    parts.push(
      el(
        'button',
        {
          class: 'btn btn-outline btn-small',
          type: 'button',
          onclick: async (e) => {
            try {
              await navigator.clipboard.writeText(window.location.href)
              e.currentTarget.textContent = 'Link copied. Paste it into Chrome or Safari'
            } catch {
              e.currentTarget.textContent = 'Copy the address from the browser bar instead'
            }
          },
        },
        'Copy this link'
      )
    )
  }
  box.replaceChildren(...parts)
  box.classList.remove('hidden')
}

function clearHelp() {
  $('#camera-help').classList.add('hidden')
}

function explainCameraError(e) {
  const name = (e && (e.name || e.type)) || String(e || '')
  const text = String((e && e.message) || e || '')
  if (/NotAllowed|PermissionDenied|Permission/i.test(name + text)) {
    return 'Camera access is blocked. Allow the camera for this site (tap the lock or camera icon in the address bar, then Camera, then Allow) and press Start camera again.'
  }
  if (/NotFound|DevicesNotFound|no camera/i.test(name + text)) {
    return 'No camera was found on this device. Use "Scan from a photo", manual entry or search instead.'
  }
  if (/NotReadable|TrackStart|in use/i.test(name + text)) {
    return 'The camera is being used by another app. Close that app and press Start camera again.'
  }
  if (/Security/i.test(name)) {
    return 'The browser blocked the camera on this page. Open the link in Chrome or Safari over HTTPS.'
  }
  return `The camera could not be started (${name || 'unknown error'}). Use "Scan from a photo", manual entry or search instead.`
}

// Starts the live scanner. Tries the back camera first, then any camera.
async function startCamera() {
  const note = $('#camera-note')
  clearHelp()

  if (!window.isSecureContext) {
    showHelp('The camera only works on a secure (HTTPS) page. Open this link over HTTPS, or use "Scan from a photo", manual entry or search.')
    return
  }
  if (typeof Html5Qrcode === 'undefined') {
    showHelp('The scanner could not be loaded. Check your connection, or use "Scan from a photo", manual entry or search.')
    return
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showHelp(
      inAppBrowser()
        ? 'This app\'s built-in browser cannot use the camera. Open the link in Chrome or Safari, or use "Scan from a photo".'
        : 'This browser cannot use the camera. Try Chrome or Safari, or use "Scan from a photo".',
      { copyLink: true }
    )
    return
  }

  const size = (w, h) => {
    const edge = Math.max(150, Math.floor(Math.min(w, h) * 0.7))
    return { width: edge, height: edge }
  }
  const config = { fps: 10, qrbox: size }
  const onScan = (text) => handleCode(text.trim())

  try {
    scanner = scanner || new Html5Qrcode('reader')
    try {
      await scanner.start({ facingMode: 'environment' }, config, onScan, () => {})
    } catch (first) {
      const name = (first && first.name) || ''
      // Permission, missing or busy cameras will not be fixed by trying another one.
      if (/NotAllowed|PermissionDenied|NotFound|NotReadable|Security/i.test(name + String(first))) throw first
      const cameras = await Html5Qrcode.getCameras()
      if (!cameras || cameras.length === 0) throw first
      const back = cameras.find((c) => /back|rear|environment/i.test(c.label)) || cameras[cameras.length - 1]
      await scanner.start(back.id, config, onScan, () => {})
    }
    scanning = true
    note.textContent = "Point the camera at the participant's QR code."
    $('#camera-toggle').textContent = 'Stop camera'
  } catch (e) {
    scanning = false
    note.textContent = ''
    const blocked = inAppBrowser()
    showHelp(
      blocked
        ? "This app's built-in browser is blocking the camera. Open the link in Chrome or Safari, or use \"Scan from a photo\" below."
        : explainCameraError(e),
      { copyLink: blocked }
    )
  }
}

async function stopCamera() {
  if (scanner && scanning) {
    try {
      await scanner.stop()
    } catch {
      /* already stopped */
    }
  }
  scanning = false
  const toggle = $('#camera-toggle')
  if (toggle) toggle.textContent = 'Start camera'
}

// Reads a QR code from a photo taken with the phone's camera app. Works even where
// the live camera is blocked (in-app browsers, denied permission).
async function scanPhoto(file) {
  if (!file) return
  if (typeof Html5Qrcode === 'undefined') {
    showResult('error', 'Scanner not available', 'Use manual entry or search instead.')
    return
  }
  await stopCamera()
  const reader = new Html5Qrcode('file-reader')
  try {
    const text = await reader.scanFile(file, false)
    await handleCode(String(text).trim())
  } catch {
    showResult(
      'error',
      'No QR code found in that photo',
      'Make sure the whole QR code is visible, well lit and in focus, then try again.'
    )
  } finally {
    try {
      reader.clear()
    } catch {
      /* nothing to clear */
    }
  }
}

// ---------------------------------------------------------------------------
// Search by name or phone
// ---------------------------------------------------------------------------
function renderMatches(rows) {
  const host = $('#matches')
  $('#confirm').classList.add('hidden')
  if (rows.length === 0) {
    host.replaceChildren(el('div', { class: 'ci-card muted' }, 'No participants found for that search.'))
    return
  }
  host.replaceChildren(
    ...rows.map((p) =>
      el(
        'button',
        { class: 'match', type: 'button', onclick: () => confirmPerson(p) },
        el('span', {}, el('span', { class: 'who' }, p.full_name), el('div', { class: 'phone' }, p.phone_hint)),
        p.checked_in
          ? el('span', { class: 'badge badge-success' }, 'Checked in')
          : el('span', { class: 'badge badge-muted' }, 'Not yet')
      )
    )
  )
}

function confirmPerson(p) {
  const box = $('#confirm')
  box.replaceChildren(
    el('p', { class: 'muted', style: 'margin:0' }, 'Confirm this is the right person:'),
    el('p', { class: 'confirm-name' }, p.full_name),
    el('p', { class: 'muted' }, `Phone ${p.phone_hint}`),
    p.checked_in
      ? el('div', { class: 'notice notice-warning' }, `Already checked in at ${formatDateTime(p.checked_in_at)}.`)
      : el(
          'button',
          {
            class: 'btn btn-primary btn-big',
            type: 'button',
            onclick: async (e) => {
              e.currentTarget.disabled = true
              const { data, error } = await call('volunteer_check_in', {
                p_token: token,
                p_registration_id: p.registration_id,
              })
              if (applyOutcome(data, error, 'Marked present')) {
                box.classList.add('hidden')
                await Promise.all([loadEvent(), runSearch()])
              } else {
                e.currentTarget.disabled = false
              }
            },
          },
          'Mark Present'
        ),
    el('button', { class: 'btn btn-outline btn-big', type: 'button', onclick: () => box.classList.add('hidden') }, 'Cancel')
  )
  box.classList.remove('hidden')
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

async function runSearch() {
  const q = $('#search').value.trim()
  const host = $('#matches')
  if (q.length < 3) {
    host.replaceChildren()
    $('#confirm').classList.add('hidden')
    return
  }
  const { data, error } = await call('volunteer_search', { p_token: token, p_query: q })
  if (error || !data || !data.ok) {
    if (data && ['invalid_access', 'revoked', 'expired', 'event_unavailable'].includes(data.error)) {
      lockOut(explain(data))
      return
    }
    host.replaceChildren(el('div', { class: 'notice notice-error' }, explain(data, error)))
    return
  }
  renderMatches(data.results)
}

// ---------------------------------------------------------------------------
function switchTab(which) {
  const scan = which === 'scan'
  $('#panel-scan').classList.toggle('hidden', !scan)
  $('#panel-search').classList.toggle('hidden', scan)
  $('#tab-scan').classList.toggle('active', scan)
  $('#tab-search').classList.toggle('active', !scan)
  $('#tab-scan').setAttribute('aria-selected', String(scan))
  $('#tab-search').setAttribute('aria-selected', String(!scan))
  if (!scan) stopCamera()
  result.classList.add('hidden')
}

async function init() {
  if (!isConfigured || !db) {
    status.replaceChildren(notConfiguredNotice())
    $('#event-name').textContent = 'Check-in'
    return
  }
  if (token.length < 20) {
    lockOut('This check-in link is incomplete. Open the full link you were given.')
    $('#event-name').textContent = 'Check-in'
    return
  }

  if (!(await loadEvent(true))) {
    $('#event-name').textContent = 'Check-in'
    return
  }

  $('#tab-scan').addEventListener('click', () => switchTab('scan'))
  $('#tab-search').addEventListener('click', () => {
    switchTab('search')
    $('#search').focus()
  })
  $('#camera-toggle').addEventListener('click', () => (scanning ? stopCamera() : startCamera()))
  $('#photo-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0]
    await scanPhoto(file)
    e.target.value = ''
  })
  $('#search').addEventListener('input', debounce(runSearch, 350))

  $('#manual-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const code = $('#manual-code').value.trim()
    if (code.length < 6) {
      showResult('error', 'Enter the full code', 'It looks like HOL-1A2B3C4D.')
      return
    }
    const { data, error } = await call('volunteer_check_in_qr', { p_token: token, p_code: code })
    if (applyOutcome(data, error, 'Checked in')) {
      $('#manual-code').value = ''
      await loadEvent()
    }
  })

  window.addEventListener('pagehide', stopCamera)
  startCamera()
}

init()
