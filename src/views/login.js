import { supabase } from '../supabase.js';

/**
 * Where Supabase should send the user back to after they click the magic link.
 *
 * Must be a bare origin with no fragment: the app uses a hash router, and
 * Supabase appends the session as `#access_token=…`. Sending the full
 * `window.location.href` (which carries `#dashboard`, `#points`, … after any
 * sign-out) produced `…/#points#access_token=…`, which supabase-js cannot
 * parse — the sign-in silently failed. See auth-callback.js.
 *
 * This value must also be listed verbatim under Supabase → Authentication →
 * URL Configuration → Redirect URLs, or Supabase falls back to the Site URL.
 */
function redirectTarget() {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

export function renderLogin({ error } = {}) {
  document.getElementById('app').innerHTML = `
    <div id="login-page">
      <div class="login-bg-orb orb1"></div>
      <div class="login-bg-orb orb2"></div>
      <div class="login-bg-orb orb3"></div>

      <div class="login-card">
        <div class="login-logo">
          <div class="login-logo-icon" aria-hidden="true"><i class="fas fa-wallet"></i></div>
          <h1>FinanceHub</h1>
          <p>Your personal finance command centre</p>
        </div>

        <div class="login-features">
          <div class="login-feature"><i class="fas fa-check-circle"></i> Net Worth Tracking</div>
          <div class="login-feature"><i class="fas fa-check-circle"></i> Credit Card Points</div>
          <div class="login-feature"><i class="fas fa-check-circle"></i> Asset Allocation</div>
          <div class="login-feature"><i class="fas fa-check-circle"></i> FI Progress</div>
        </div>

        <div class="login-divider">Secure Magic Link Login</div>

        <div class="login-form-group">
          <label for="email-input">Email address</label>
          <input
            type="email"
            id="email-input"
            placeholder="you@example.com"
            autocomplete="email"
          />
        </div>

        <button type="button" class="btn-primary" id="magic-link-btn">
          <i class="fas fa-paper-plane" style="margin-right:0.5rem"></i>
          Send Magic Link
        </button>

        <div class="login-status" id="login-status"></div>
      </div>
    </div>
  `;

  const btn = document.getElementById('magic-link-btn');
  const emailInput = document.getElementById('email-input');
  const status = document.getElementById('login-status');

  // Report a failed callback (expired / already-used link) instead of just
  // dropping the user back on a blank form with no explanation.
  if (error) showStatus(error, 'error');

  async function handleLogin() {
    const email = emailInput.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showStatus('Please enter a valid email address.', 'error');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:0.5rem"></i>Sending...';

    let sendError = null;
    try {
      ({ error: sendError } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTarget() }
      }));
    } catch (e) {
      // createClient throws on a missing URL/key, and the request itself can
      // fail outright — without this the button just stuck on "Sending…".
      sendError = e;
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane" style="margin-right:0.5rem"></i>Send Magic Link';

    if (sendError) {
      showStatus(`Error: ${sendError.message || 'Could not send the magic link. Please try again.'}`, 'error');
    } else {
      showStatus(
        `✨ Magic link sent to <strong>${escapeHTML(email)}</strong>. Check your inbox and click the link to sign in.`,
        'success'
      );
      emailInput.value = '';
    }
  }

  btn.addEventListener('click', handleLogin);
  emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });

  function showStatus(msg, type) {
    status.innerHTML = msg;
    status.className = `login-status ${type}`;
  }
}

// The email regex above still admits characters like `<`, so the address has to
// be escaped before it goes back out through innerHTML.
function escapeHTML(str) {
  const el = document.createElement('div');
  el.textContent = str;
  return el.innerHTML;
}
