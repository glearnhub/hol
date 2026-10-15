// Frontend configuration.
//
// SUPABASE_URL and SUPABASE_ANON_KEY come from Supabase -> Project Settings -> API.
// The anon ("publishable") key is MEANT to be public: Row Level Security and the
// database functions protect the data. NEVER put the service_role key here.
export const SUPABASE_URL = 'https://ejumkrxogcreqrfpyils.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqdW1rcnhvZ2NyZXFyZnB5aWxzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNzI1NTQsImV4cCI6MjEwNzY0ODU1NH0.j8x4zwi5lJSO4uQXVtTPGW8EITC1Wxlw4Kb-pKuPLq0'

// Shown in the footer and on the home page. Leave a value empty to hide it.
export const SITE = {
  name: 'Cassia Events',
  contactEmail: '',
  contactPhone: '',
  location: '',
}
