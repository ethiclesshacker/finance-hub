// ======================================================
// The screens, in navigation order — the one list the router validates
// hashes against and the sidebar is drawn from. This used to be three
// copies: VALID_VIEWS in router.js, NAV_ITEMS in app.js and the
// registerRoute calls under it, and adding a screen meant remembering all
// three. Import-free, so the router can read it without dragging a view in.
// ======================================================

export const NAV_ITEMS = [
  { id: 'dashboard', icon: 'fa-house',        label: 'Dashboard' },
  { id: 'networth',  icon: 'fa-chart-line',   label: 'Net Worth' },
  { id: 'fi',        icon: 'fa-bullseye',     label: 'FI Planner' },
  { id: 'points',    icon: 'fa-credit-card',  label: 'Points & Rewards' },
  { id: 'ledger',    icon: 'fa-timeline',     label: 'Life' },
  { id: 'food',      icon: 'fa-utensils',     label: 'Food' },
  { id: 'dishes',    icon: 'fa-book-open',    label: 'Dishes' },
  { id: 'health',    icon: 'fa-heart-pulse',  label: 'Health' },
  { id: 'settings',  icon: 'fa-sliders',      label: 'Settings' },
];

export const VIEW_IDS = NAV_ITEMS.map(item => item.id);
export const FALLBACK_VIEW = 'dashboard';
