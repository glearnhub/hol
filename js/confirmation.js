// Registration confirmation with the participant's QR code.
// The QR code contains ONLY the secret registration token: no name, phone or e-mail.
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm'
import { supabase, isConfigured } from './supabase-client.js'
import { renderPublicLayout } from './layout.js'
import {
  el, $, param, formatDate, formatTimeRange, notice, notConfiguredNotice, toast,
  formatSchedule,
} from './ui.js'

function readToken(reference) {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('t')
  if (fromHash) return fromHash
  // Fall back to the copy saved on this device at registration time.
  try {
    const saved = JSON.parse(localStorage.getItem('hol:registrations') || '[]')
    return saved.find((r) => r.reference === reference)?.token || null
  } catch {
    return null
  }
}

export async function initConfirmation() {
  renderPublicLayout('events')
  const host = $('#confirmation')

  if (!isConfigured) {
    host.replaceChildren(notConfiguredNotice())
    return
  }

  const reference = (param('ref') || '').trim().toUpperCase()
  const token = readToken(reference)
  if (!reference || !token) {
    notice(
      host,
      'We could not open this confirmation. Please use the link you were shown after registering.',
      'error'
    )
    return
  }

  const { data, error } = await supabase.rpc('get_registration_confirmation', {
    p_reference: reference,
    p_token: token,
  })

  if (error || !data || !data.ok) {
    notice(host, data?.message || 'We could not find that registration.', 'error')
    return
  }

  const ev = data.event
  const cancelled = data.registration_status === 'cancelled' || ev.status === 'cancelled'

  const canvas = el('canvas', { width: 240, height: 240, role: 'img', 'aria-label': 'Your registration QR code' })
  await QRCode.toCanvas(canvas, token, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#600086', light: '#FFFFFF' },
  })

  host.replaceChildren(
    el(
      'div',
      { class: 'card confirmation' },
      el('div', { class: 'success-mark', 'aria-hidden': 'true' }, '✓'),
      el('img', { src: 'img/logo.png', alt: 'Handmaidens of the Lord', class: 'confirm-logo', width: '1064', height: '812' }),
      el('h1', {}, cancelled ? 'This registration is no longer active' : 'You are registered!'),
      el(
        'p',
        {},
        cancelled
          ? 'This event or registration has been cancelled. Please contact the organisers.'
          : `Thank you, ${data.full_name}. Your place has been reserved.`
      ),
      el('h2', {}, ev.name),
      el('p', {}, `${formatSchedule(ev)}`),
      el('p', {}, `📍 ${ev.venue}`),
      el('div', { class: 'reference' }, data.registration_reference),
      cancelled ? null : el('div', {}, el('div', { class: 'qr-box' }, canvas)),
      cancelled
        ? null
        : el('p', { class: 'muted' }, 'Show this QR code at the entrance to check in. A printed copy works too.'),
      el(
        'div',
        { class: 'card-actions no-print', style: 'justify-content:center' },
        el('button', { class: 'btn btn-primary', type: 'button', onclick: () => window.print() }, 'Print / save as PDF'),
        cancelled
          ? null
          : el(
              'button',
              {
                class: 'btn btn-outline',
                type: 'button',
                onclick: () => {
                  const a = el('a', { href: canvas.toDataURL('image/png'), download: `${reference}-qr.png` })
                  document.body.append(a)
                  a.click()
                  a.remove()
                },
              },
              'Download QR code'
            ),
        el(
          'button',
          {
            class: 'btn btn-outline',
            type: 'button',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(window.location.href)
                toast('Link copied')
              } catch {
                toast('Copy this page address from your browser', 'error')
              }
            },
          },
          'Copy my link'
        )
      ),
      el(
        'p',
        { class: 'muted no-print', style: 'margin-top:1rem;font-size:.85rem' },
        'Keep this page private: anyone with this link can use your QR code. Bookmark it or save the link so you can find it again.'
      )
    )
  )
}
