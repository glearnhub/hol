// Home page and "Upcoming Events" listing.
import { supabase, isConfigured } from './supabase-client.js'
import { posterUrls } from './posters.js'
import { renderPublicLayout, brandMark } from './layout.js'
import {
  el, $, formatDate, formatTimeRange, notice, notConfiguredNotice, REGISTRATION_STATE, debounce,
  formatSchedule,
} from './ui.js'

export async function fetchPublicEvents() {
  const { data, error } = await supabase
    .from('public_events')
    .select('*')
    .order('event_date', { ascending: true })
    .order('start_time', { ascending: true })
  if (error) throw error
  return data || []
}

// Shows the WHOLE poster, never cropped or stretched. The same image, blurred, fills
// the rest of the frame so portrait and landscape posters both look tidy.
export function posterBlock(url, alt) {
  const safe = url ? url.replace(/["\\()\s]/g, (c) => encodeURIComponent(c)) : ''
  return el(
    'div',
    { class: 'poster', style: url ? `--poster-url: url("${safe}")` : null },
    url ? el('img', { src: url, alt, loading: 'lazy', decoding: 'async' }) : brandMark(72)
  )
}

export function stateBadge(state) {
  const s = REGISTRATION_STATE[state] || REGISTRATION_STATE.closed
  return el('span', { class: `badge badge-${s.tone}` }, s.label)
}

export function eventCard(ev, posterUrl) {
  const open = ev.registration_state === 'open'
  const spots =
    open && ev.spots_remaining !== null && ev.spots_remaining !== undefined
      ? `${ev.spots_remaining} space${ev.spots_remaining === 1 ? '' : 's'} left`
      : null

  return el(
    'article',
    { class: 'event-card' },
    posterBlock(posterUrl, `Poster for ${ev.name}`),
    el(
      'div',
      { class: 'event-card-body' },
      stateBadge(ev.registration_state),
      el('h3', {}, ev.name),
      el('div', { class: 'meta' }, '📅', el('span', {}, `${formatSchedule(ev)}`)),
      el('div', { class: 'meta' }, '📍', el('span', {}, ev.venue)),
      spots ? el('div', { class: 'meta' }, '🎟️', el('span', {}, spots)) : null,
      el(
        'div',
        { class: 'card-actions' },
        open
          ? el('a', { class: 'btn btn-primary btn-small', href: `register.html?id=${ev.id}` }, 'Register')
          : null,
        el('a', { class: 'btn btn-outline btn-small', href: `event-details.html?id=${ev.id}` }, 'View details')
      )
    )
  )
}

async function renderEvents(host, events, emptyMessage) {
  if (events.length === 0) {
    host.replaceChildren(el('p', { class: 'muted' }, emptyMessage))
    return
  }
  const urls = await posterUrls(events.map((e) => e.poster_path))
  host.replaceChildren(...events.map((ev) => eventCard(ev, urls.get(ev.poster_path))))
}

export async function initHome() {
  renderPublicLayout('home')
  const host = $('#featured-events')
  if (!isConfigured) {
    host.replaceChildren(notConfiguredNotice())
    return
  }
  try {
    const events = (await fetchPublicEvents()).filter((e) => e.registration_state !== 'ended').slice(0, 6)
    await renderEvents(host, events, 'There are no upcoming events right now. Please check back soon.')
  } catch {
    notice(host, 'We could not load events right now. Please try again shortly.', 'error')
  }
}

export async function initEvents() {
  renderPublicLayout('events')
  const host = $('#events-list')
  const search = $('#search')
  const showPast = $('#show-past')

  if (!isConfigured) {
    host.replaceChildren(notConfiguredNotice())
    return
  }

  let all = []
  try {
    all = await fetchPublicEvents()
  } catch {
    notice(host, 'We could not load events right now. Please try again shortly.', 'error')
    return
  }

  const paint = async () => {
    const q = search.value.trim().toLowerCase()
    let list = all.filter((e) => showPast.checked || e.registration_state !== 'ended')
    if (q) {
      list = list.filter((e) =>
        [e.name, e.venue, e.description].some((t) => (t || '').toLowerCase().includes(q))
      )
    }
    await renderEvents(
      host,
      list,
      q ? 'No events match your search.' : 'There are no upcoming events right now. Please check back soon.'
    )
  }

  search.addEventListener('input', debounce(paint, 200))
  showPast.addEventListener('change', paint)
  await paint()
}
