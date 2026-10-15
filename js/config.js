// Frontend configuration.
//
// SUPABASE_URL and SUPABASE_ANON_KEY come from Supabase -> Project Settings -> API.
// The anon ("publishable") key is MEANT to be public: Row Level Security and the
// database functions protect the data. NEVER put the service_role key here.
export const SUPABASE_URL = 'https://ejumkrxogcreqrfpyils.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqdW1rcnhvZ2NyZXFyZnB5aWxzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNzI1NTQsImV4cCI6MjEwNzY0ODU1NH0.j8x4zwi5lJSO4uQXVtTPGW8EITC1Wxlw4Kb-pKuPLq0'

// Site name shown in the header, footer and page titles.
export const SITE = {
  name: 'Handmaidens of the Lord',
}

// Designer credit shown in the footer. It is a WhatsApp link that opens a chat
// with the number below and the message pre-filled.
export const CREDIT = {
  designer: 'Gideon Kiplangat',
  company: 'Tekipra Systems',
  whatsapp: '0702499324',
  message: 'Hello Tekipra Systems, I saw your work on the Handmaidens of the Lord website and I would like to talk about a project.',
}
