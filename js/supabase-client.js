// Single place where the Supabase client is created.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

// A hosted project (https://xxxx.supabase.co) or a local Supabase / test server
// (http://localhost or http://127.0.0.1, optionally with a port).
export const isConfigured =
  /^(https:\/\/[a-z0-9-]+\.supabase\.co|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/?$/i.test(SUPABASE_URL) &&
  Boolean(SUPABASE_ANON_KEY) &&
  SUPABASE_ANON_KEY !== 'YOUR-ANON-KEY'

// Used by the public pages and the administrator area (keeps the admin signed in).
export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null

// Used by the volunteer check-in page: never reads or stores a login session, so
// volunteer calls always run as the anonymous role even on an admin's device.
export function createAnonymousClient() {
  if (!isConfigured) return null
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}
