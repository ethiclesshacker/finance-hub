import { supabase } from '../supabase.js';
import { USER_NAME } from '../constants.js';
import { navigateTo, registerRoute, startRouter } from '../router.js';
import { renderDashboard } from './dashboard.js';
import { renderNetWorth } from './networth.js';
import { renderPoints } from './points.js';

const NAV_ITEMS = [
  { id: 'dashboard', icon: 'fa-house',       label: 'Dashboard' },
  { id: 'networth',  icon: 'fa-chart-line',  label: 'Net Worth' },
  { id: 'points',    icon: 'fa-credit-card', label: 'Points & Rewards' },
];

export function renderApp(session) {
  // Register all routes
  registerRoute('dashboard', renderDashboard);
  registerRoute('networth',  renderNetWorth);
  registerRoute('points',    renderPoints);

  const userEmail = session?.user?.email || '';

  document.getElementById('app').innerHTML = `
    <!-- Mobile Header -->
    <div class="mobile-header">
      <button class="hamburger" id="hamburger-btn">
        <i class="fas fa-bars"></i>
      </button>
      <span style="font-weight:800;font-size:1rem;background:linear-gradient(135deg,var(--accent),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">FinanceHub</span>
      <div style="width:36px"></div>
    </div>

    <div id="app-shell">
      <!-- Sidebar overlay (mobile) -->
      <div class="sidebar-overlay" id="sidebar-overlay"></div>

      <!-- Sidebar -->
      <nav class="sidebar" id="sidebar">
        <div class="sidebar-logo">
          <div class="sidebar-logo-icon">💰</div>
          <div>
            <div class="sidebar-logo-text">FinanceHub</div>
            <div class="sidebar-logo-sub">Personal Finance</div>
          </div>
        </div>

        <div class="sidebar-nav">
          ${NAV_ITEMS.map(item => `
            <div
              class="nav-item ${item.id === 'dashboard' ? 'active' : ''}"
              data-view="${item.id}"
              id="nav-${item.id}"
            >
              <i class="fas ${item.icon}"></i>
              ${item.label}
            </div>
          `).join('')}
        </div>

        <div class="sidebar-footer">
          <div class="user-profile">
            <div class="user-avatar">${USER_NAME[0]}</div>
            <div class="user-info">
              <div class="user-name">${USER_NAME}</div>
              <div class="user-email" title="${userEmail}">${userEmail || 'Signed in'}</div>
            </div>
            <button class="sign-out-btn" id="sign-out-btn" title="Sign out">
              <i class="fas fa-arrow-right-from-bracket"></i>
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
  });
  overlay?.addEventListener('click', closeSidebar);

  function closeSidebar() {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('visible');
  }

  // Load initial view
  startRouter();
}
