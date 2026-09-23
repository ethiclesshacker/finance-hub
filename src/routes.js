// ======================================================
// The screens, in navigation order — the one list the router validates
// hashes against and the sidebar is drawn from. This used to be three
// copies: VALID_VIEWS in router.js, NAV_ITEMS in app.js and the
// registerRoute calls under it, and adding a screen meant remembering all
// three. Import-free, so the router can read it without dragging a view in.
//
// Grouped by how often a screen is opened, not by when it was built. The
// daily record (the ledger, what you ate, the Watch) comes first; money,
// which moves weekly at most, second; Settings last. Dishes sits under Food
// because it is Food's dictionary. `group` is a sidebar heading; an item
// without one continues the group above it.
// ======================================================

export const NAV_ITEMS = [
  { id: 'dashboard', icon: 'fa-house',        label: 'Dashboard' },

  { id: 'ledger',    icon: 'fa-timeline',     label: 'Life',             group: 'Every day' },
  { id: 'food',      icon: 'fa-utensils',     label: 'Food' },
  { id: 'dishes',    icon: 'fa-book-open',    label: 'Dishes' },
  { id: 'health',    icon: 'fa-heart-pulse',  label: 'Health' },

  { id: 'points',    icon: 'fa-credit-card',  label: 'Points & Rewards', group: 'Money' },
  { id: 'networth',  icon: 'fa-chart-line',   label: 'Net Worth' },
  { id: 'fi',        icon: 'fa-bullseye',     label: 'FI Planner' },

  { id: 'settings',  icon: 'fa-sliders',      label: 'Settings',         group: '' },
];

export const VIEW_IDS = NAV_ITEMS.map(item => item.id);
export const FALLBACK_VIEW = 'dashboard';
