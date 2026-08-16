import { supabase } from '../supabase.js';
import * as settings from '../settings.js';
import { escapeHTML } from '../utils.js';
import { navigateTo, registerRoute, startRouter } from '../router.js';
import { renderDashboard } from './dashboard.js';
import { renderNetWorth } from './networth.js';
import { renderPoints } from './points.js';
import { renderFI } from './fi.js';
import { renderSettings } from './settings.js';

const NAV_ITEMS = [
  { id: 'dashboard', icon: 'fa-house',        label: 'Dashboard' },
  { id: 'networth',  icon: 'fa-chart-line',   label: 'Net Worth' },
  { id: 'fi',        icon: 'fa-bullseye',     label: 'FI Planner' },
  { id: 'points',    icon: 'fa-credit-card',  label: 'Points & Rewards' },
  { id: 'settings',  icon: 'fa-sliders',      label: 'Settings' },
];

export function renderApp(session) {
  // Register all routes
  registerRoute('dashboard', renderDashboard);
  registerRoute('networth',  renderNetWorth);
  registerRoute('points',    renderPoints);
  registerRoute('fi',        renderFI);
  registerRoute('settings',  renderSettings);

  const userEmail = session?.user?.email || '';
  // Falls back to the local part of the email until a display name is set.
  const userName  = settings.get('display_name') || userEmail.split('@')[0] || 'You';

  document.getElementById('app').innerHTML = `
    <!-- Mobile Header -->
    <div class="mobile-header">
      <button type="button" class="hamburger" id="hamburger-btn" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">
        <i class="fas fa-bars"></i>
      </button>
      <span style="font-weight:800;font-size:1rem;background:linear-gradient(135deg,var(--accent),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">FinanceHub</span>
      <div style="width:36px"></div>
    </div>

    <div id="app-shell">
      <!-- Sidebar overlay (mobile) -->
      <div class="sidebar-overlay" id="sidebar-overlay"></div>

      <!-- Sidebar -->
      <nav class="sidebar" id="sidebar" aria-label="Main">
        <div class="sidebar-logo">
          <div class="sidebar-logo-icon">💰</div>
          <div>
            <div class="sidebar-logo-text">FinanceHub</div>
            <div class="sidebar-logo-sub">Personal Finance</div>
          </div>
        </div>

        <div class="sidebar-nav">
          ${NAV_ITEMS.map(item => `
            <button
              type="button"
              class="nav-item ${item.id === 'dashboard' ? 'active' : ''}"
              data-view="${item.id}"
              id="nav-${item.id}"
              ${item.id === 'dashboard' ? 'aria-current="page"' : ''}
            >
              <i class="fas ${item.icon}" aria-hidden="true"></i>
              ${escapeHTML(item.label)}
            </button>
          `).join('')}
        </div>

        <div class="sidebar-footer">
          <div class="user-profile">
            <div class="user-avatar">${escapeHTML(userName[0].toUpperCase())}</div>
            <div class="user-info">
              <div class="user-name">${escapeHTML(userName)}</div>
              <div class="user-email" title="${escapeHTML(userEmail)}">${escapeHTML(userEmail) || 'Signed in'}</div>
            </div>
            <button type="button" class="sign-out-btn" id="sign-out-btn" title="Sign out" aria-label="Sign out">
              <i class="fas fa-arrow-right-from-bracket" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </nav>

      <!-- Main content area -->
      <main class="main-content" id="main-content">
        <div id="view-container"></div>
      </main>
    </div>
  `;

  // Navigation click handlers
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => {
      navigateTo(item.dataset.view);
      closeSidebar();
    });
  });

  // Sign out
  document.getElementById('sign-out-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
  });

  // Mobile sidebar toggle
  const hamburger = document.getElementById('hamburger-btn');
  const overlay   = document.getElementById('sidebar-overlay');
  const sidebar   = document.getElementById('sidebar');

  hamburger?.addEventListener('click', () => {
    sidebar.classList.add('open');
    overlay.classList.add('visible');
    hamburger.setAttribute('aria-expanded', 'true');
  });
  overlay?.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSidebar();
  });

  function closeSidebar() {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('visible');
    hamburger?.setAttribute('aria-expanded', 'false');
  }

  // Load initial view
  startRouter();
}
