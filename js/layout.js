// Public site header and footer, rendered into every public page.
import { SITE, CREDIT } from './config.js'
import { el, $ } from './ui.js'

// wa.me link that opens a WhatsApp chat with the designer, message pre-filled.
// The number is stored with a leading 0 in config; WhatsApp needs the country code.
function whatsappLink() {
  const digits = CREDIT.whatsapp.replace(/\D/g, '').replace(/^0/, '254')
  return `https://wa.me/${digits}?text=${encodeURIComponent(CREDIT.message)}`
}

// The Handmaidens of the Lord emblem (ring and torch).
export function brandMark(size = 40) {
  return el('img', {
    src: 'img/logo-emblem.png',
    alt: '',
    width: String(size),
    height: String(size),
    class: 'brand-logo',
  })
}

export function renderPublicLayout(active = '') {
  const links = [
    { href: 'index.html', label: 'Home', key: 'home' },
    { href: 'events.html', label: 'Upcoming Events', key: 'events' },
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

  const footer = el(
    'footer',
    { class: 'site-footer' },
    el(
      'div',
      { class: 'container footer-inner' },
      el('div', {}, el('strong', {}, SITE.name), el('p', {}, 'Events made simple: register, attend, celebrate.')),
      el('ul', { class: 'footer-links' },
        el('li', {}, el('a', { href: 'events.html' }, 'Upcoming events'))
      ),
      el(
        'p',
        { class: 'copyright' },
        `© ${new Date().getFullYear()} ${SITE.name}. All rights reserved.`,
        el('br'),
        el(
          'a',
          {
            class: 'credit-link',
            href: whatsappLink(),
            target: '_blank',
            rel: 'noopener noreferrer',
            title: `Contact ${CREDIT.company}`,
          },
          `Designed by ${CREDIT.designer} of ${CREDIT.company}`
        )
      )
    )
  )

  const headerHost = $('#site-header')
  const footerHost = $('#site-footer')
  if (headerHost) headerHost.replaceWith(header)
  if (footerHost) footerHost.replaceWith(footer)
}
