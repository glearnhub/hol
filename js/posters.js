// Event posters live in a PRIVATE storage bucket. The database only lets
// visitors read posters of published events, and the site fetches short-lived
// signed links (one batched request per page).
import { supabase } from './supabase-client.js'

const BUCKET = 'event-posters'

// Returns Map(path -> signed URL). Missing or unreadable posters are simply omitted.
export async function posterUrls(paths, expiresInSeconds = 3600) {
  const unique = [...new Set((paths || []).filter(Boolean))]
  const urls = new Map()
  if (!supabase || unique.length === 0) return urls

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(unique, expiresInSeconds)
  if (error || !data) return urls
  for (const item of data) {
    if (item.signedUrl && !item.error) urls.set(item.path, item.signedUrl)
  }
  return urls
}

export const POSTER_BUCKET = BUCKET
