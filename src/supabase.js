import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

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
