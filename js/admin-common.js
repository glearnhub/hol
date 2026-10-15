// Helpers shared by the administrator pages.
import { supabase } from './supabase-client.js'
import { el } from './ui.js'

// Calls a database function and throws on transport errors or {ok:false} replies.
export async function callRpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(error.message || 'Request failed')
  if (data && data.ok === false) throw new Error(data.message || data.error || 'Request failed')
  return data
}

export function eventStatusBadge(status) {
  const map = {
    draft: ['Draft', 'muted'],
    published: ['Published', 'success'],
    cancelled: ['Cancelled', 'error'],
  }
  const [label, tone] = map[status] || [status, 'muted']
  return el('span', { class: `badge badge-${tone}` }, label)
}

// Attendance wording. Absence is only claimed once the event has finished.
export function attendanceLabel(row, eventEnded) {
  if (row.status === 'cancelled') return { text: 'Cancelled', tone: 'error' }
  if (row.checked_in_at) return { text: 'Present', tone: 'success' }
  return eventEnded ? { text: 'Absent', tone: 'warning' } : { text: 'Not Checked In', tone: 'muted' }
}

export function attendanceBadge(row, eventEnded) {
  const { text, tone } = attendanceLabel(row, eventEnded)
  return el('span', { class: `badge badge-${tone}` }, text)
}

export function errorText(e) {
  const msg = (e && e.message) || ''
  if (/not_authorized|permission denied/i.test(msg)) return 'You do not have permission to do that.'
  return msg || 'Something went wrong. Please try again.'
}
