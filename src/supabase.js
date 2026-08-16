import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Vite inlines these at *build* time. A build run without .env present (or a CI
// build with the vars unset) ships a bundle where createClient throws on import
// and the page renders blank with only a console error — fail loudly instead.
if (!SUPABASE_URL || !SUPABASE_KEY) {
  document.getElementById('app').innerHTML =
    '<div style="max-width:34rem;margin:20vh auto;padding:1.5rem;font-family:Inter,system-ui,sans-serif;color:#e2e8f0;background:#1e293b;border-radius:12px;line-height:1.6">' +
    '<h1 style="font-size:1.1rem;margin:0 0 .75rem">Configuration error</h1>' +
    '<p style="margin:0;color:#94a3b8">This build is missing <code>VITE_SUPABASE_URL</code> / <code>VITE_SUPABASE_ANON_KEY</code>. ' +
    'They are baked in at build time, so set them in <code>.env</code> and run <code>npm run build</code> again before deploying.</p></div>';
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY at build time.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession:    true,  // store session in localStorage → survives page reloads & browser restarts
    autoRefreshToken:  true,  // silently refresh the access token before it expires
    detectSessionInUrl: true, // pick up magic link tokens from the URL automatically
    storageKey: 'finance-hub-session', // namespaced key so it doesn't clash with other Supabase apps
  },
});

/** Returns the current authenticated user's UUID, or null if not signed in. */
export async function getCurrentUserId() {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}
