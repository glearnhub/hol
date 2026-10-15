// Frontend configuration.
//
// SUPABASE_URL and SUPABASE_ANON_KEY come from Supabase -> Project Settings -> API.
// The anon ("publishable") key is MEANT to be public: Row Level Security and the
// database functions protect the data. NEVER put the service_role key here.
export const SUPABASE_URL = 'YOUR-PROJECT-URL'
export const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY'

// Shown in the footer and on the home page. Leave a value empty to hide it.
export const SITE = {
  name: 'Handmaidens of the Lord',
  contactEmail: '',
  contactPhone: '',
  location: '',
}
