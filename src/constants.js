// ======================================================
// Application constants.
//
// These describe what the app and the card actually support — not what any
// individual user prefers. Everything that is a personal number (income,
// expenses, FI multiplier, targets, thresholds) moved to per-user settings in
// src/settings.js, backed by the user_settings table, so changing your budget
// no longer means a rebuild and a redeploy.
// ======================================================

// Points / HSBC TravelOne
export const EUR_INR_FALLBACK = 110.00;

export const MULTIPLIER_OPTIONS = [
  { label: '0× (Non-earning)', value: 0 },
  { label: '2× (Base rate)', value: 2 },
  { label: '4× (Select merchants)', value: 4 },
  { label: '16× (Partner bonus)', value: 16 },
  { label: '24× (Max bonus)', value: 24 },
];

// Reward partners
export const REDEMPTION_PARTNERS = [
  'United Miles', 'Singapore KrisFlyer', 'Air India',
  'British Airways Avios', 'Cathay Asia Miles', 'Emirates Skywards',
  'Marriott Bonvoy', 'IHG One Rewards', 'Hilton Honors',
  // No "Other": the partner field takes any name you type, and an event
  // recorded against "Other" is a redemption whose partner you cannot look up.
  'Club Vistara', 'Etihad Guest', 'Accor ALL',
];
