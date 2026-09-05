import { supabase } from '../supabase.js';
import * as settings from '../settings.js';
import { escapeHTML } from '../utils.js';
import { navigateTo, registerRoute, startRouter } from '../router.js';
import { renderDashboard } from './dashboard.js';
import { renderNetWorth } from './networth.js';
import { renderPoints } from './points.js';
import { renderFI } from './fi.js';
import { renderSettings } from './settings.js';
import { renderLedger } from './ledger.js';
import { renderFood } from './food.js';
import { renderDishes } from './dishes.js';

// Private-mode Safari throws on localStorage, and a thrown preference must
// not take the navigation down with it.
const RAIL_KEY = 'finance-hub-sidebar-rail';

function isRailCollapsed() {
  try { return localStorage.getItem(RAIL_KEY) === '1'; } catch (_) { return false; }
}

const NAV_ITEMS = [
  { id: 'dashboard', icon: 'fa-house',        label: 'Dashboard' },
  { id: 'networth',  icon: 'fa-chart-line',   label: 'Net Worth' },
  { id: 'fi',        icon: 'fa-bullseye',     label: 'FI Planner' },
  { id: 'points',    icon: 'fa-credit-card',  label: 'Points & Rewards' },
  { id: 'ledger',    icon: 'fa-timeline',     label: 'Life' },
  { id: 'food',      icon: 'fa-utensils',     label: 'Food' },
  { id: 'dishes',    icon: 'fa-book-open',    label: 'Dishes' },
  { id: 'settings',  icon: 'fa-sliders',      label: 'Settings' },
];

export function renderApp(session) {
  // Register all routes
  registerRoute('dashboard', renderDashboard);
  registerRoute('networth',  renderNetWorth);
  registerRoute('points',    renderPoints);
  registerRoute('fi',        renderFI);
  registerRoute('ledger',    renderLedger);
  registerRoute('food',      renderFood);
  registerRoute('dishes',    renderDishes);
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
      <span class="mobile-header-title">FinanceHub</span>
      <span class="mobile-header-spacer" aria-hidden="true"></span>
    </div>

    <div id="app-shell">
      <!-- Sidebar overlay (mobile) -->
      <div class="sidebar-overlay" id="sidebar-overlay"></div>

      <!-- Sidebar -->
      <nav class="sidebar" id="sidebar" aria-label="Main">
        <!-- Collapses the sidebar to an icon rail on desktop. Below the
             breakpoint where the sidebar is a drawer there is nothing to
             collapse, so the button is hidden there. -->
        <button type="button" class="sidebar-toggle" id="sidebar-toggle"
                aria-controls="sidebar" aria-expanded="true" title="Collapse sidebar">
          <i class="fas fa-angles-left" aria-hidden="true"></i>
          <span class="sr-only">Collapse sidebar</span>
        </button>

        <div class="sidebar-logo">
          <div class="sidebar-logo-icon" aria-hidden="true"><i class="fas fa-wallet"></i></div>
          <div class="sidebar-logo-names">
            <div class="sidebar-logo-text">FinanceHub</div>
            <div class="sidebar-logo-sub">Personal finance</div>
          </div>
        </div>

        <div class="sidebar-nav">
          ${NAV_ITEMS.map(item => `
            <button
              type="button"
              class="nav-item ${item.id === 'dashboard' ? 'active' : ''}"
              data-view="${item.id}"
              id="nav-${item.id}"
              title="${escapeHTML(item.label)}"
              ${item.id === 'dashboard' ? 'aria-current="page"' : ''}
            >
              <i class="fas ${item.icon}" aria-hidden="true"></i>
              <span class="nav-item-label">${escapeHTML(item.label)}</span>
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

  // ── Sidebar rail ──────────────────────────────────────
  //
  // Collapsed state is per browser, not per account: it is a preference about
  // this screen, so localStorage rather than user_settings — no round trip,
  // and it is applied before the first paint of the next visit.
  const shell        = document.getElementById('app-shell');
  const railToggle   = document.getElementById('sidebar-toggle');

  function setRail(collapsed) {
    shell.classList.toggle('is-rail', collapsed);
    railToggle.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    railToggle.title = label;
    railToggle.querySelector('.sr-only').textContent = label;
    try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch (_) {}
  }

  setRail(isRailCollapsed());
  railToggle.addEventListener('click', () => setRail(!shell.classList.contains('is-rail')));

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
