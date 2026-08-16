// ======================================================
// Magic-link callback handling
//
// IMPORTANT: this module must be imported BEFORE ./supabase.js.
// supabase-js starts reading (and clearing) the URL the moment the
// client is constructed, so anything we want off the URL has to be
// snapshotted first. ES modules evaluate in import order, so the
// import position in main.js is load-bearing.
// ======================================================

/**
 * Supabase uses the implicit flow by default, which returns the session in
 * the URL *fragment*: `#access_token=…&refresh_token=…`.
 *
 * This app also uses a hash router (`#dashboard`, `#points`). If the login
 * page was reached with a route still in the URL — which is what happens
 * after every sign-out, and after a session expires mid-session — the old
 * `emailRedirectTo: window.location.href` baked that route into the magic
 * link, and the callback came back looking like:
 *
 *     https://finance.aadityavs.dev/#points#access_token=eyJ…
 *
 * supabase-js parses `location.hash.substring(1)` as a query string, so the
 * first key becomes `points#access_token` and `access_token` is never found.
 * It throws "No session defined in URL" and the user silently lands back on
 * the login screen.
 *
 * login.js now sends a clean origin as the redirect, but links already sitting
 * in an inbox still carry the broken shape — so repair the URL here as well.
 */
function repairAuthHash() {
  const raw = window.location.hash;
  if (!raw || raw.indexOf('#', 1) === -1) return; // no stray second '#'

  const authPart = raw.slice(raw.lastIndexOf('#') + 1);
  if (!/(^|&)(access_token|error|error_code)=/.test(authPart)) return;

  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search + '#' + authPart
  );
}

/** Collect auth params from both the fragment and the query string. */
function readAuthParams() {
  const params = {};

  const hash = window.location.hash.replace(/^#/, '');
  if (hash.includes('=')) {
    new URLSearchParams(hash).forEach((v, k) => { params[k] = v; });
  }
  new URLSearchParams(window.location.search).forEach((v, k) => { params[k] = v; });

  return params;
}

repairAuthHash();
const CALLBACK_PARAMS = readAuthParams();

/**
 * True when this page load is a magic-link callback — used to avoid flashing
 * the login screen while supabase-js exchanges the token.
 */
export function isAuthCallback() {
  return Boolean(CALLBACK_PARAMS.access_token || CALLBACK_PARAMS.code || CALLBACK_PARAMS.error || CALLBACK_PARAMS.error_code);
}

/**
 * A human-readable reason the magic link failed, or null.
 *
 * Supabase reports failures as `#error=access_denied&error_code=otp_expired&…`
 * and supabase-js strips them from the URL without surfacing them anywhere the
 * UI can reach — so previously an expired or already-used link just looked like
 * "nothing happened".
 */
export function getAuthCallbackError() {
  const code = CALLBACK_PARAMS.error_code || CALLBACK_PARAMS.error;
  if (!code) return null;

  const description = (CALLBACK_PARAMS.error_description || '').replace(/\+/g, ' ');

  switch (code) {
    case 'otp_expired':
      return 'That magic link has expired. Magic links are valid for a short window — request a new one below.';
    case 'access_denied':
      return description || 'That magic link is no longer valid. It may have already been used. Request a new one below.';
    default:
      return description || `Sign-in failed (${code}). Request a new link below.`;
  }
}

/** Drop any auth params / stale route from the URL bar. */
export function clearAuthParamsFromURL() {
  if (!window.location.hash && !window.location.search) return;
  window.history.replaceState(window.history.state, '', window.location.pathname);
}
