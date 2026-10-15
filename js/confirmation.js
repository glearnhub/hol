// Registration confirmation with the participant's QR code.
// The QR code contains ONLY the secret registration token: no name, phone or e-mail.
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm'
import { supabase, isConfigured } from './supabase-client.js'
import { renderPublicLayout } from './layout.js'
import {
  el, $, param, notice, notConfiguredNotice, formatSchedule,
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

// Draws a ticket picture (logo, event, reference and QR code) on a canvas, so one tap
// saves everything the participant needs, like a screenshot of this page would.
function wrapLines(ctx, text, maxWidth) {
  const lines = []
  let line = ''
  for (const word of String(text).split(/\s+/)) {
    const test = line ? `${line} ${word}` : word
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line)
      line = word
    } else line = test
  }
  if (line) lines.push(line)
  return lines
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

async function buildTicket({ qrCanvas, eventName, when, venue, person, reference }) {
  const W = 900
  const pad = 60
  const font = (w, size) => `${w} ${size}px Poppins, "Segoe UI", Arial, sans-serif`
  const measure = document.createElement('canvas').getContext('2d')
  measure.font = font(700, 44)
  const nameLines = wrapLines(measure, eventName, W - pad * 2)
  measure.font = font(500, 30)
  const whenLines = wrapLines(measure, when, W - pad * 2)

  const logo = await loadImage('img/logo.png')
  const logoH = logo ? 300 : 0
  const qr = 480
  const H = 90 + logoH + 40 + nameLines.length * 56 + whenLines.length * 42 + 52 + 40 + 90 + qr + 190

  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#600086'
  ctx.fillRect(0, 0, W, 24)
  ctx.fillRect(0, H - 24, W, 24)
  ctx.textAlign = 'center'

  let y = 70
  if (logo) {
    const w = (logo.width * logoH) / logo.height
    ctx.drawImage(logo, (W - w) / 2, y, w, logoH)
    y += logoH + 40
  }
  ctx.fillStyle = '#600086'
  ctx.font = font(700, 44)
  for (const l of nameLines) { y += 52; ctx.fillText(l, W / 2, y); y += 4 }
  ctx.fillStyle = '#333333'
  ctx.font = font(500, 30)
  y += 14
  for (const l of whenLines) { y += 42; ctx.fillText(l, W / 2, y) }
  ctx.fillStyle = '#555555'
  ctx.font = font(400, 28)
  y += 52
  ctx.fillText(venue, W / 2, y)
  y += 40
  ctx.fillStyle = '#333333'
  ctx.font = font(600, 30)
  ctx.fillText(person, W / 2, y + 40)
  y += 90

  // The QR code must stay crisp, so it is scaled without smoothing.
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#d9c2e6'
  ctx.lineWidth = 3
  ctx.strokeRect((W - qr) / 2 - 18, y - 18, qr + 36, qr + 36)
  ctx.drawImage(qrCanvas, (W - qr) / 2, y, qr, qr)
  y += qr + 80
  ctx.fillStyle = '#600086'
  ctx.font = '700 40px "Courier New", monospace'
  ctx.fillText(reference, W / 2, y)
  ctx.fillStyle = '#777777'
  ctx.font = font(400, 24)
  ctx.fillText('Show this QR code at the entrance to check in.', W / 2, y + 48)
  return c
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
        : el(
            'p',
            { class: 'muted' },
            'Show this QR code at the entrance to check in. Tap “Save ticket as image” below, or ',
            el('strong', { class: 'highlight-word' }, 'TAKE A SCREENSHOT OF THIS PAGE'),
            ', so it is on your phone even without internet.'
          ),
      cancelled
        ? null
        : el(
            'div',
            { class: 'card-actions no-print', style: 'justify-content:center' },
            el(
              'button',
              {
                class: 'btn btn-primary',
                type: 'button',
                onclick: async (e) => {
                  const btn = e.currentTarget
                  btn.disabled = true
                  try {
                    const ticket = await buildTicket({
                      qrCanvas: canvas,
                      eventName: ev.name,
                      when: formatSchedule(ev),
                      venue: ev.venue,
                      person: data.full_name,
                      reference,
                    })
                    const a = el('a', { href: ticket.toDataURL('image/png'), download: `${reference}-ticket.png` })
                    document.body.append(a)
                    a.click()
                    a.remove()
                  } finally {
                    btn.disabled = false
                  }
                },
              },
              'Save ticket as image'
            )
          ),
      el(
        'p',
        { class: 'muted no-print', style: 'margin-top:1rem;font-size:.85rem' },
        'Keep your QR code private: anyone who has it can use your place.'
      )
    )
  )
}
