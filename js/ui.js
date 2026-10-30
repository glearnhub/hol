// Small, dependency-free helpers shared by every page.

// Builds DOM nodes without innerHTML, so user-supplied text can never become markup.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, value)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

// Replaces a container's content, skipping empty slots (replaceChildren would print "null").
export function setChildren(host, ...children) {
  host.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false))
}

export const $ = (selector, root = document) => root.querySelector(selector)
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

export function param(name) {
  return new URLSearchParams(window.location.search).get(name)
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')
}

// ---- Dates and times (event dates are plain calendar dates, not instants) ----
export function formatDate(day) {
  if (!day) return ''
  // Accept "2026-11-14" and also a full timestamp that starts with the date.
  const d = new Date(`${String(day).slice(0, 10)}T00:00:00`)
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatTime(time) {
  if (!time) return ''
  const [h, m] = time.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function formatTimeRange(start, end) {
  return end ? `${formatTime(start)} – ${formatTime(end)}` : formatTime(start)
}

// An event may end on a later day than it starts (an all-night vigil, a retreat).
export function isMultiDay(ev) {
  return Boolean(ev.end_date) && String(ev.end_date).slice(0, 10) !== String(ev.event_date).slice(0, 10)
}

// One readable line for when an event happens, same-day or overnight.
export function formatSchedule(ev) {
  if (!isMultiDay(ev)) return `${formatDate(ev.event_date)} · ${formatTimeRange(ev.start_time, ev.end_time)}`
  const end = ev.end_time ? `${formatDate(ev.end_date)}, ${formatTime(ev.end_time)}` : formatDate(ev.end_date)
  return `${formatDate(ev.event_date)}, ${formatTime(ev.start_time)} → ${end}`
}

export function formatDateTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

// ---- Messages -----------------------------------------------------------------
export function notice(container, message, type = 'info') {
  container.replaceChildren(el('div', { class: `notice notice-${type}`, role: 'alert' }, message))
}

export function clearNotice(container) {
  container.replaceChildren()
}

export function toast(message, type = 'success') {
  let host = $('#toast-host')
  if (!host) {
    host = el('div', { id: 'toast-host', 'aria-live': 'polite' })
    document.body.append(host)
  }
  const t = el('div', { class: `toast toast-${type}` }, message)
  host.append(t)
  setTimeout(() => t.classList.add('toast-out'), 3200)
  setTimeout(() => t.remove(), 3700)
}

// ---- Modal dialogs (used instead of the browser's own confirm / alert / prompt boxes) ----
// confirmDialog -> true/false, promptDialog -> the text typed, or null when cancelled, alertDialog -> nothing.
function openModal({ title, message, field, confirmLabel, cancelLabel, danger }) {
  return new Promise((resolve) => {
    const input = field
      ? el('textarea', { id: 'modal-input', rows: '3', maxlength: String(field.maxlength || 300), placeholder: field.placeholder || '' })
      : null
    const cancelButton = cancelLabel === null ? null : el('button', { class: 'btn btn-outline', type: 'button' }, cancelLabel || 'Cancel')
    const okButton = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit' }, confirmLabel || 'OK')
    const form = el(
      'form',
      { class: 'modal-form', novalidate: true },
      el('h2', { class: 'modal-title' }, title),
      el('p', { class: 'modal-message' }, message),
      field ? el('label', { class: 'modal-label', for: 'modal-input' }, field.label || '') : null,
      input,
      el('div', { class: 'row-actions modal-actions' }, cancelButton, okButton)
    )
    const dialog = el('dialog', { class: 'modal-dialog', 'aria-label': title }, form)
    // Resolve straight from the buttons; Escape and the close event are only a fallback.
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      if (dialog.open) dialog.close()
      dialog.remove()
      if (field) resolve(value === true ? input.value.trim() : null)
      else resolve(cancelLabel === null ? undefined : value === true)
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      finish(true)
    })
    if (cancelButton) cancelButton.addEventListener('click', () => finish(false))
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      finish(false)
    })
    dialog.addEventListener('close', () => finish(false))
    document.body.append(dialog)
    dialog.showModal()
    // A destructive action starts on Cancel so that pressing Enter never deletes by accident.
    ;(input || (danger && cancelButton) || okButton).focus()
  })
}

export const confirmDialog = (message, { title = 'Please confirm', confirmLabel = 'Yes, continue', cancelLabel = 'Cancel', danger = false } = {}) =>
  openModal({ title, message, confirmLabel, cancelLabel, danger })

export const alertDialog = (message, { title = 'Notice', confirmLabel = 'OK' } = {}) =>
  openModal({ title, message, confirmLabel, cancelLabel: null })

export const promptDialog = (message, { title = 'Add a note', label = '', placeholder = '', confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false, maxlength = 300 } = {}) =>
  openModal({ title, message, field: { label, placeholder, maxlength }, confirmLabel, cancelLabel, danger })

export function notConfiguredNotice() {
  return el(
    'div',
    { class: 'notice notice-warning' },
    el('strong', {}, 'This site is not connected to Supabase yet. '),
    'Add your project URL and anon key to js/config.js (see README.md).'
  )
}

// ---- Validation (the database repeats every one of these checks) ---------------
export function normalizePhone(input) {
  let d = String(input || '').replace(/[^0-9+]/g, '')
  if (d.startsWith('+')) d = d.slice(1).replace(/[^0-9]/g, '')
  else if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = '254' + d.slice(1)
  else if (/^[17][0-9]{8}$/.test(d)) d = '254' + d
  // "+254 0712..." (the leading 0 typed again after the country code)
  if (/^2540[0-9]{9}$/.test(d)) d = '254' + d.slice(4)
  return '+' + d
}

export function validateRegistration({ fullName, email, phone, church }) {
  const errors = {}
  const name = fullName.trim().replace(/\s+/g, ' ')
  if (name.length < 2 || name.length > 100) errors.fullName = 'Please enter your full name.'
  // The email address is optional; when one is given it must look valid.
  if (email.trim() && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) || email.trim().length > 254)) {
    errors.email = 'Please enter a valid email address.'
  }
  if (!/^\+[0-9]{9,15}$/.test(normalizePhone(phone))) {
    errors.phone = 'Please enter a valid phone number, for example 0712 345 678.'
  }
  const c = church.trim()
  if (c.length < 2 || c.length > 150) errors.church = 'Please enter your church name.'
  return errors
}

// ---- Friendly text for state codes returned by the database --------------------
export const REGISTRATION_STATE = {
  open: { label: 'Registration open', tone: 'success' },
  full: { label: 'Fully booked', tone: 'error' },
  closed: { label: 'Registration closed', tone: 'muted' },
  not_open: { label: 'Opens soon', tone: 'info' },
  unavailable: { label: 'Registration unavailable', tone: 'muted' },
  ended: { label: 'Event ended', tone: 'muted' },
}

// ---- CSV (Excel-compatible: UTF-8 BOM, CRLF, formula injection guard) ----------
export function toCsv(columns, rows) {
  const cell = (value) => {
    let s = value === null || value === undefined ? '' : String(value)
    // A cell starting with = + - @ could be run as a formula by Excel. Plain phone
    // numbers such as +254712345678 are left alone so they stay readable.
    const plainNumber = /^[+-][0-9][0-9 ().-]*$/.test(s)
    if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !plainNumber)) s = `'${s}`
    return `"${s.replace(/"/g, '""')}"`
  }
  const lines = [columns.map((c) => cell(c.header)).join(',')]
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(','))
  return '﻿' + lines.join('\r\n')
}

export function downloadFile(filename, content, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = el('a', { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event'
}

export function debounce(fn, ms = 300) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

export const CHECKIN_ERRORS = {
  invalid_access: 'This check-in link is not valid.',
  revoked: 'This check-in link has been revoked. Ask an administrator for a new one.',
  expired: 'This check-in link has expired. Ask an administrator for a new one.',
  event_unavailable: 'This event is not open for check-in.',
  rate_limited: 'Too many requests. Please wait a moment and try again.',
  invalid_code: 'That code is not valid for this event.',
  not_found: 'No matching registration was found for this event.',
  outside_window: 'Check-in is not open for this event right now.',
  query_too_short: 'Type at least 3 characters.',
  attendance_disabled: 'Attendance is not being recorded for this event.',
  walkins_not_allowed: 'This link cannot register new visitors. Ask an administrator.',
  consent_required: 'Confirm that the visitor agrees to their details being recorded.',
  invalid_name: 'Enter the visitor\'s full name.',
  invalid_phone: 'Enter a valid phone number, for example 0712 345 678.',
}
