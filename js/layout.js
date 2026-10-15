// Public site header and footer, rendered into every public page.
import { SITE } from './config.js'
import { el, $ } from './ui.js'

// Simple brand mark: a cross inside a soft circle.
export function brandMark(size = 40) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML =
    '<circle cx="24" cy="24" r="23" fill="#EDE9FE" stroke="#7C3AED" stroke-width="1.5"/>' +
    '<path d="M21 9h6v12h12v6H27v14h-6V27H9v-6h12z" fill="#4C1D95"/>' +
    '<circle cx="24" cy="24" r="3" fill="#EDE9FE"/>'
  return svg
}

export function renderPublicLayout(active = '') {
  const links = [
    { href: 'index.html', label: 'Home', key: 'home' },
    { href: 'events.html', label: 'Upcoming Events', key: 'events' },
    { href: 'index.html#about', label: 'About', key: 'about' },
    { href: 'index.html#contact', label: 'Contact', key: 'contact' },
  ]

  const nav = el(
    'nav',
    { class: 'site-nav', id: 'site-nav', 'aria-label': 'Main' },
    ...links.map((l) =>
      el('a', { href: l.href, class: l.key === active ? 'active' : '' }, l.label)
    )
  )

  const toggle = el(
    'button',
    {
      class: 'nav-toggle',
      type: 'button',
      'aria-label': 'Open menu',
      'aria-expanded': 'false',
      'aria-controls': 'site-nav',
      onclick: (e) => {
        const open = nav.classList.toggle('open')
        e.currentTarget.setAttribute('aria-expanded', String(open))
      },
    },
    el('span'), el('span'), el('span')
  )

  const header = el(
    'header',
    { class: 'site-header' },
    el(
      'div',
      { class: 'container header-inner' },
      el('a', { href: 'index.html', class: 'brand' }, brandMark(38), el('span', {}, SITE.name)),
      toggle,
      nav
    )
  )

  const contactBits = []
  if (SITE.contactEmail) contactBits.push(el('li', {}, 'Email: ', el('a', { href: `mailto:${SITE.contactEmail}` }, SITE.contactEmail)))
  if (SITE.contactPhone) contactBits.push(el('li', {}, 'Phone: ', el('a', { href: `tel:${SITE.contactPhone.replace(/\s+/g, '')}` }, SITE.contactPhone)))
  if (SITE.location) contactBits.push(el('li', {}, SITE.location))

  const footer = el(
    'footer',
    { class: 'site-footer' },
    el(
      'div',
      { class: 'container footer-inner' },
      el('div', {}, el('strong', {}, SITE.name), el('p', {}, 'Events made simple: register, attend, celebrate.')),
      el('ul', { class: 'footer-links' },
        el('li', {}, el('a', { href: 'events.html' }, 'Upcoming events')),
        el('li', {}, el('a', { href: 'index.html#about' }, 'About us')),
        ...contactBits
      ),
      el('p', { class: 'copyright' }, `© ${new Date().getFullYear()} ${SITE.name}. All rights reserved.`)
    )
  )

  const headerHost = $('#site-header')
  const footerHost = $('#site-footer')
  if (headerHost) headerHost.replaceWith(header)
  if (footerHost) footerHost.replaceWith(footer)
}
