// Single event page.
import { supabase, isConfigured } from './supabase-client.js'
import { posterUrls } from './posters.js'
import { renderPublicLayout } from './layout.js'
import { posterBlock, stateBadge } from './public-events.js'
import {
  el, $, param, isUuid, formatDate, formatTimeRange, formatDateTime, notice, notConfiguredNotice,
} from './ui.js'

const STATE_MESSAGES = {
  full: 'This event is fully booked.',
  closed: 'Registration for this event has closed.',
  not_open: 'Registration has not opened yet.',
  ended: 'This event has already taken place.',
}

export async function initEventDetails() {
  renderPublicLayout('events')
  const host = $('#event-detail')

  if (!isConfigured) {
    host.replaceChildren(notConfiguredNotice())
    return
  }

  const id = param('id')
  if (!isUuid(id)) {
    notice(host, 'We could not find that event.', 'error')
    return
  }

  const { data: ev, error } = await supabase.from('public_events').select('*').eq('id', id).maybeSingle()
  if (error) {
    notice(host, 'We could not load this event right now. Please try again shortly.', 'error')
    return
  }
  if (!ev) {
    notice(host, 'This event is not available. It may have been unpublished or cancelled.', 'error')
    return
  }

  document.title = `${ev.name} · Cassia Events`
  const urls = await posterUrls([ev.poster_path], 3600)

  const open = ev.registration_state === 'open'
  const facts = [
    ['Date', formatDate(ev.event_date)],
    ['Time', formatTimeRange(ev.start_time, ev.end_time)],
    ['Venue', ev.venue],
    ev.registration_closes_at ? ['Register by', formatDateTime(ev.registration_closes_at)] : null,
    ['Capacity', `${ev.capacity} participants`],
    ev.spots_remaining !== null && ev.spots_remaining !== undefined
      ? ['Spaces left', String(ev.spots_remaining)]
      : null,
  ].filter(Boolean)

  host.replaceChildren(
    el(
      'div',
      { class: 'detail-layout' },
      el('div', { class: 'detail-poster' }, posterBlock(urls.get(ev.poster_path), `Poster for ${ev.name}`)),
      el(
        'div',
        {},
        stateBadge(ev.registration_state),
        el('h1', {}, ev.name),
        el('ul', { class: 'facts' }, ...facts.map(([k, v]) => el('li', {}, el('strong', {}, k), el('span', {}, v)))),
        el('p', { class: 'description' }, ev.description || ''),
        open
          ? el('a', { class: 'btn btn-primary', href: `register.html?id=${ev.id}` }, 'Register now')
          : el('div', { class: 'notice notice-info' }, STATE_MESSAGES[ev.registration_state] || 'Registration is not available.'),
        el('p', {}, el('a', { href: 'events.html' }, '← Back to all events'))
      )
    )
  )
}
