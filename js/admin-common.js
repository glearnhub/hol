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
    completed: ['Completed', 'info'],
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

export const CATEGORIES = {
  general: 'General',
  service: 'Church service',
  prayer: 'Prayer meeting',
  fellowship: 'Fellowship',
  training: 'Training',
  leadership: 'Leadership meeting',
  conference: 'Conference',
  outreach: 'Outreach',
  other: 'Other',
}

export const VISIBILITY = {
  public: { label: 'Public', hint: 'Listed on the website; anyone can register.' },
  private: { label: 'Private', hint: 'Never listed. People reach it only through its registration link.' },
  internal: { label: 'Internal', hint: 'Never listed. For leadership and member meetings.' },
}

// The four membership types, in the order they are offered.
export const MEMBERSHIP_TYPES = {
  incoming_commitment: 'Incoming Commitment Class',
  in_commitment: 'In Commitment Class',
  member: 'Member',
  visitor: 'Visitor',
}

export function membershipTypeLabel(type) {
  return MEMBERSHIP_TYPES[type] || 'Member'
}

export function membershipBadge(type) {
  const tone = type === 'member' ? 'success' : type === 'visitor' ? 'info' : 'warning'
  return el('span', { class: `badge badge-${tone}` }, membershipTypeLabel(type))
}

// "Member" / "Visitor" label that stays the same wherever it appears.
export function kindBadge(kind) {
  return kind === 'member'
    ? el('span', { class: 'badge badge-success' }, 'Member')
    : el('span', { class: 'badge badge-info' }, 'Visitor')
}

// A readable "M-00012" style number for display next to a name.
export function personLabel(p) {
  return p.label || ''
}
