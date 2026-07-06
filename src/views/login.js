import { supabase } from '../supabase.js';

export function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div id="login-page">
      <div class="login-bg-orb orb1"></div>
      <div class="login-bg-orb orb2"></div>
      <div class="login-bg-orb orb3"></div>

      <div class="login-card">
        <div class="login-logo">
          <div class="login-logo-icon">💰</div>
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

        <button class="btn-primary" id="magic-link-btn">
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

  async function handleLogin() {
    const email = emailInput.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showStatus('Please enter a valid email address.', 'error');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:0.5rem"></i>Sending...';

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href }
    });

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane" style="margin-right:0.5rem"></i>Send Magic Link';

    if (error) {
      showStatus(`Error: ${error.message}`, 'error');
    } else {
      showStatus(
        `✨ Magic link sent to <strong>${email}</strong>. Check your inbox and click the link to sign in.`,
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
