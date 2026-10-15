// Administrator authentication and the shared admin shell (sidebar + top bar).
//
// IMPORTANT: this file only decides what to SHOW. The real protection is Row Level
// Security and the admin_* database functions, which refuse non-administrators no
// matter what the browser does.
import { supabase, isConfigured } from './supabase-client.js'
import { brandMark } from './layout.js'
import { el, $, notice, notConfiguredNotice } from './ui.js'

const NAV = [
  { key: 'dashboard', href: 'admin-dashboard.html', label: 'Dashboard', icon: '▦' },
  { key: 'events', href: 'manage-events.html', label: 'Events', icon: '📅' },
  { key: 'reports', href: 'reports.html', label: 'Reports', icon: '📊' },
]

export async function signOut() {
  await supabase.auth.signOut()
  window.location.href = 'admin-login.html'
}

async function isAdminUser(userId) {
  const { data, error } = await supabase
    .from('admin_roles')
    .select('role')
    .eq('user_id', userId)
    .maybeSingle()
  return !error && Boolean(data)
}

function renderShell(active, session) {
  const sidebar = $('#admin-sidebar')
  const topbar = $('#admin-topbar')

  sidebar.replaceChildren(
    el('a', { href: 'admin-dashboard.html', class: 'admin-brand' }, brandMark(34), el('span', {}, 'Handmaidens of the Lord')),
    el(
      'nav',
      { 'aria-label': 'Administration' },
      ...NAV.map((n) =>
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
        onclick: () => sidebar.classList.toggle('open'),
      },
      '☰'
    ),
    el('span', { class: 'muted' }, session.user.email),
    el('button', { class: 'btn btn-outline btn-small', type: 'button', onclick: signOut }, 'Log out')
  )
}

// Call at the top of every admin page. Resolves with the session, or redirects.
export async function requireAdmin(active) {
  const main = $('#page')
  if (!isConfigured) {
    main?.classList.remove('hidden')
    main?.replaceChildren(notConfiguredNotice())
    return null
  }

  const { data } = await supabase.auth.getSession()
  const session = data.session
  if (!session) {
    window.location.replace('admin-login.html')
    return null
  }

  if (!(await isAdminUser(session.user.id))) {
    await supabase.auth.signOut()
    window.location.replace('admin-login.html?denied=1')
    return null
  }

  renderShell(active, session)
  main?.classList.remove('hidden')

  // If the session ends while the page is open, send the user back to log in.
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.replace('admin-login.html')
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

  // Already signed in as an admin: go straight to the dashboard.
  const { data } = await supabase.auth.getSession()
  if (data.session && (await isAdminUser(data.session.user.id))) {
    window.location.replace('admin-dashboard.html')
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
    } else if (!(await isAdminUser(result.session.user.id))) {
      await supabase.auth.signOut()
      notice(status, 'That account does not have administrator access.', 'error')
    } else {
      window.location.replace('admin-dashboard.html')
      return
    }

    button.disabled = false
    button.textContent = 'Sign in'
  })
}
