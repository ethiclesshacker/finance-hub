// Hash-based SPA router
// URLs: /#dashboard, /#networth, /#points, /#ledger, /#food
// Handles refresh, back/forward, and deep-links automatically.

const routes = {};

export function registerRoute(id, renderFn) {
  routes[id] = renderFn;
}

const VALID_VIEWS = ['dashboard', 'networth', 'points', 'fi', 'ledger', 'food', 'settings'];
const FALLBACK    = 'dashboard';

/** Read the current hash and return the view ID it maps to. */
function hashToView() {
  const hash = window.location.hash.replace('#', '').trim();
  return VALID_VIEWS.includes(hash) ? hash : FALLBACK;
}

/** Navigate to a view — updates hash, active nav item, renders the view. */
export function navigateTo(viewId) {
  if (!VALID_VIEWS.includes(viewId)) viewId = FALLBACK;

  // Only push a new hash if we're actually changing views
  // (avoids double-render on the initial hashchange after page load)
  if (window.location.hash !== '#' + viewId) {
    window.location.hash = viewId;
    return; // hashchange handler will call _render
  }

  _render(viewId);
}

function _render(viewId) {
  // Update nav active state
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    const isActive = item.dataset.view === viewId;
    item.classList.toggle('active', isActive);
    // Tell assistive tech which view is current, not just which one is blue.
    if (isActive) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });

  const container = document.getElementById('view-container');
  if (!container) return;

  const renderFn = routes[viewId] || routes[FALLBACK];
  if (renderFn) renderFn(container);
}

let isListenerAdded = false;

/** Call once after the app shell is mounted. */
export function startRouter() {
  // Handle back/forward and hash changes
  if (!isListenerAdded) {
    window.addEventListener('hashchange', () => _render(hashToView()));
    isListenerAdded = true;
  }

  // Render the initial view from the current hash (handles refresh & deep-link)
  _render(hashToView());
}

export function getCurrentView() {
  return hashToView();
}
