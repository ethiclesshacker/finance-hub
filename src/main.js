// NOTE: ./auth-callback.js must stay above ./supabase.js — it snapshots the
// magic-link params out of the URL before supabase-js clears them.
import { isAuthCallback, getAuthCallbackError, clearAuthParamsFromURL } from './auth-callback.js';
import { supabase } from './supabase.js';
import './vendor.js';
import { loadSettings } from './settings.js';
import { renderLogin } from './views/login.js';
import { renderApp } from './views/app.js';
import { applyChartDefaults } from './utils.js';
import './style.css';

// Which user is currently painted on screen.
//   undefined → nothing rendered yet
//   null      → login screen
//   <uuid>    → app shell for that user
let renderedUserId;

async function render(session) {
  const userId = session?.user?.id ?? null;

  // Auth events fire far more often than the UI actually changes —
  // TOKEN_REFRESHED every hour, SIGNED_IN again whenever the tab regains
  // focus. Re-rendering on those wiped the DOM mid-use and bounced the
  // user back to the dashboard, so only repaint on a real identity change.
  if (userId === renderedUserId) return;
  renderedUserId = userId;

  if (userId) {
    // Every view reads settings synchronously, so they have to be in hand
    // before the shell mounts. loadSettings never rejects — a missing table or
    // a network blip falls back to the schema defaults.
    await loadSettings();
    renderApp(session);
  } else {
    clearAuthParamsFromURL(); // don't bake a stale #route into the next magic link
    renderLogin({ error: getAuthCallbackError() });
  }
}

async function init() {
  // Apply Chart.js global defaults once — all views share these settings.
  applyChartDefaults();

  // getSession() awaits the client's initialisation, which includes exchanging
  // a magic-link token in the URL. On a callback load that means the session is
  // already live here and we never flash the login screen.
  const { data: { session } } = await supabase.auth.getSession();

  if (!session && isAuthCallback() && !getAuthCallbackError()) {
    // Callback params were present but no session came out of them. Surface it
    // rather than silently showing an empty login form.
    renderedUserId = null;
    clearAuthParamsFromURL();
    renderLogin({ error: 'Could not complete sign-in from that link. Please request a new one.' });
  } else {
    await render(session);
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    // Never call back into supabase from inside this callback — it runs while
    // the auth lock is held and any await on supabase.* deadlocks. Renders kick
    // off data fetches, so bounce to a fresh task first.
    setTimeout(() => {
      render(session).catch(err => console.error('[auth] render failed:', err));
    }, 0);
  });
}

init().catch(err => {
  console.error('[init] failed:', err);
  document.getElementById('app').innerHTML =
    '<div style="max-width:34rem;margin:20vh auto;padding:1.5rem;font-family:Inter,system-ui,sans-serif;color:#e2e8f0;background:#1e293b;border-radius:12px;line-height:1.6">' +
    '<h1 style="font-size:1.1rem;margin:0 0 .75rem">Something went wrong starting up</h1>' +
    '<p style="margin:0;color:#94a3b8">Reload the page. If it keeps happening, check the browser console for details.</p></div>';
});
