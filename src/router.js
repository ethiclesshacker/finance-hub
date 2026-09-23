// Hash-based SPA router
// URLs: /#dashboard, /#networth, /#points, /#ledger, /#food, /#dishes, /#health
// Handles refresh, back/forward, and deep-links automatically.
//
// A view is registered as { render, unmount }. Before a new view is drawn the
// previous one's unmount runs, which is where charts, grids, timers and
// document-level listeners are released — without it every visit to a screen
// leaked the last visit's Chart.js instances and their resize observers.

import { VIEW_IDS, FALLBACK_VIEW } from './routes.js';

const routes = {};
let currentId = null;

/**
 * @param {string} id
 * @param {(container: HTMLElement) => void|Promise<void>} render
 * @param {() => void} [unmount]
 */
export function registerRoute(id, render, unmount) {
  routes[id] = { render, unmount };
}

/** Read the current hash and return the view ID it maps to. */
function hashToView() {
  const hash = window.location.hash.replace('#', '').trim();
  return VIEW_IDS.includes(hash) ? hash : FALLBACK_VIEW;
}

/** Navigate to a view — updates hash, active nav item, renders the view. */
export function navigateTo(viewId) {
  if (!VIEW_IDS.includes(viewId)) viewId = FALLBACK_VIEW;

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

  // Let the outgoing view release what it holds before its DOM goes away.
  const leaving = currentId && routes[currentId];
  if (leaving?.unmount) {
    try { leaving.unmount(); } catch (err) { console.error(`[router] unmount ${currentId} failed:`, err); }
  }

  const route = routes[viewId] || routes[FALLBACK_VIEW];
  currentId = route ? viewId : null;
  if (route?.render) {
    Promise.resolve(route.render(container))
      .catch(err => console.error(`[router] render ${viewId} failed:`, err));
  }
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
