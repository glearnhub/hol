// Administrator authentication and the shared admin shell (sidebar + top bar).
//
// IMPORTANT: this file only decides what to SHOW. The real protection is Row Level
// Security and the admin_* database functions, which refuse non-administrators no
// matter what the browser does.
import { supabase, isConfigured } from './supabase-client.js'
import { brandMark } from './layout.js'
import { el, $, notice, notConfiguredNotice } from './ui.js'

// Which sidebar items each role sees. (Hiding links is only a convenience: the database
// refuses anything a role is not allowed to do.)
const NAV = [
  { key: 'dashboard', href: 'admin-dashboard.html', label: 'Dashboard', icon: '▦', roles: ['admin'] },
  { key: 'events', href: 'manage-events.html', label: 'Events', icon: '📅', roles: ['admin', 'manager'] },
  { key: 'members', href: 'members.html', label: 'Members', icon: '👥', roles: ['admin'] },
  { key: 'visitors', href: 'visitors.html', label: 'Visitors', icon: '🙋', roles: ['admin'] },
  { key: 'deaconesses', href: 'deaconesses.html', label: 'Deaconesses', icon: '🤝', roles: ['admin'] },
  { key: 'ranking', href: 'attendance-ranking.html', label: 'Attendance ranking', icon: '🏆', roles: ['admin'] },
  { key: 'reports', href: 'reports.html', label: 'Reports', icon: '📊', roles: ['admin', 'manager'] },
]

export const ROLE_LABELS = { admin: 'Administrator', manager: 'Event manager' }

// Where each role lands after signing in.
const HOME = { admin: 'admin-dashboard.html', manager: 'manage-events.html' }

export async function signOut() {
  await supabase.auth.signOut()
  window.location.href = 'admin.html'
}

// The signed-in user's role ('admin', 'manager') or null when they have none.
async function getRole(userId) {
  const { data, error } = await supabase
    .from('admin_roles')
    .select('role')
    .eq('user_id', userId)
    .maybeSingle()
  return !error && data ? data.role : null
}

function renderShell(active, session, role) {
  const sidebar = $('#admin-sidebar')
  const topbar = $('#admin-topbar')

  sidebar.replaceChildren(
    el('a', { href: HOME[role] || 'admin-dashboard.html', class: 'admin-brand' }, brandMark(34), el('span', {}, 'Handmaidens of the Lord')),
    el(
      'nav',
      { 'aria-label': 'Administration' },
      ...NAV.filter((n) => n.roles.includes(role)).map((n) =>
        el('a', { href: n.href, class: n.key === active ? 'active' : '' }, el('span', { 'aria-hidden': 'true' }, n.icon), n.label)
      )
    ),
    el('div', { class: 'sidebar-foot' }, el('a', { href: 'index.html' }, '← View public site'))
  )

  topbar.replaceChildren(
    el(
      'button',
      {
        class: 'menu-btn',
        type: 'button',
        'aria-label': 'Toggle menu',
        'aria-expanded': 'false',
        onclick: (e) => {
          const open = sidebar.classList.toggle('open')
          e.currentTarget.setAttribute('aria-expanded', String(open))
        },
      },
      '☰'
    ),
    el('span', { class: 'muted topbar-email' }, `${session.user.email} · ${ROLE_LABELS[role] || role}`),
    el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: signOut }, 'Log out')
  )

  // On phones the menu slides over the page: tapping anywhere else closes it.
  document.addEventListener('click', (e) => {
    if (!sidebar.classList.contains('open')) return
    if (sidebar.contains(e.target) || e.target.closest('.menu-btn')) return
    sidebar.classList.remove('open')
    topbar.querySelector('.menu-btn')?.setAttribute('aria-expanded', 'false')
  })
}

// Phones show tables as stacked cards. The CSS needs each cell to know its column
// heading (data-label), so label cells as tables are drawn or redrawn.
function labelTables() {
  const label = () => {
    for (const table of document.querySelectorAll('table.data')) {
      const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
      for (const row of table.querySelectorAll('tbody tr')) {
        ;[...row.children].forEach((cell, i) => {
          if (cell.hasAttribute('data-label')) return
          const heading = heads[i] || ''
          cell.setAttribute('data-label', heading)
          // Keep a cell's content together as one block beside its label.
          if (heading && cell.childNodes.length > 0) {
            const wrap = document.createElement('span')
            wrap.className = 'cell-value'
            wrap.append(...cell.childNodes)
            cell.append(wrap)
          }
        })
      }
    }
  }
  new MutationObserver(label).observe(document.body, { childList: true, subtree: true })
  label()
}

// Call at the top of every admin page. Resolves with the session (session.role is the
// user's role), or redirects. Pass { roles: ['admin', 'manager'] } on pages managers may use.
export async function requireAdmin(active, { roles = ['admin'] } = {}) {
  const main = $('#page')
  if (!isConfigured) {
    main?.classList.remove('hidden')
    main?.replaceChildren(notConfiguredNotice())
    return null
  }

  const { data } = await supabase.auth.getSession()
  const session = data.session
  if (!session) {
    window.location.replace('admin.html')
    return null
  }

  const role = await getRole(session.user.id)
  if (!role) {
    await supabase.auth.signOut()
    window.location.replace('admin.html?denied=1')
    return null
  }
  if (!roles.includes(role)) {
    // Signed in, but this page is not for their role: send them to their own home page.
    window.location.replace(HOME[role] || 'admin.html')
    return null
  }
  session.role = role

  renderShell(active, session, role)
  labelTables()
  main?.classList.remove('hidden')

  // If the session ends while the page is open, send the user back to log in.
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.replace('admin.html')
  })

  return session
}

// Login page
export async function initLogin() {
  const status = $('#status')
  const form = $('#login-form')

  if (!isConfigured) {
    status.replaceChildren(notConfiguredNotice())
    form.classList.add('hidden')
    return
  }

  if (new URLSearchParams(window.location.search).get('denied')) {
    notice(status, 'That account does not have administrator access.', 'error')
  }

  // Already signed in: go straight to the right home page.
  const { data } = await supabase.auth.getSession()
  const existingRole = data.session ? await getRole(data.session.user.id) : null
  if (existingRole) {
    window.location.replace(HOME[existingRole] || 'admin-dashboard.html')
    return
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    status.replaceChildren()
    const button = $('#login-btn')
    button.disabled = true
    button.textContent = 'Signing in…'

    const { data: result, error } = await supabase.auth.signInWithPassword({
      email: form.email.value.trim(),
      password: form.password.value,
    })

    if (error || !result.session) {
      notice(status, 'Incorrect email or password.', 'error')
    } else {
      const role = await getRole(result.session.user.id)
      if (!role) {
        await supabase.auth.signOut()
        notice(status, 'That account does not have administrator access.', 'error')
      } else {
        window.location.replace(HOME[role] || 'admin-dashboard.html')
        return
      }
    }

    button.disabled = false
    button.textContent = 'Sign in'
  })
}
