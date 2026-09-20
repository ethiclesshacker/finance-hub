// ======================================================
// The settings catalogue, on its own and free of imports.
//
// settings.js needs the browser's Supabase client, so nothing outside a
// browser could import it — which left Hermes unable to know that the calorie
// target is 1,800 unless the user had happened to save one. Moved here, the
// same catalogue is read by the app, by the Hermes tool layer (get_targets),
// and by tests. settings.js re-exports it, so no caller changed.
// ======================================================

// ======================================================
// Per-user settings, stored key/value in public.user_settings.
//
// This catalogue is the source of truth for every user-configurable number in
// the app. It replaces what used to be hardcoded in constants.js, where
// changing your own monthly budget meant a rebuild and a redeploy.
//
// The database column is plain jsonb, so type safety lives here instead:
// each entry declares its type, default, bounds and label. Adding a setting is
// one object literal — no migration, and the settings screen picks it up
// automatically.
//
// What deliberately does NOT live here: MULTIPLIER_OPTIONS, REDEMPTION_PARTNERS
// and the colour tokens. Those describe what the card and the app actually
// support, not what the user prefers, and they stay in constants.js.
// ======================================================

export const SETTINGS_SCHEMA = {
  display_name: {
    type: 'string', default: '', group: 'Profile',
    label: 'Display name', hint: 'Used in the dashboard greeting and the sidebar.',
  },
  age: {
    type: 'number', default: 26, min: 15, max: 100, step: 1, group: 'Profile',
    label: 'Age', suffix: 'years', hint: 'Drives the wealth score and the Coast FI horizon.',
  },
  retirement_age: {
    type: 'number', default: 60, min: 30, max: 100, step: 1, group: 'Profile',
    label: 'Target retirement age', suffix: 'years', hint: 'The age Coast FI compounds towards.',
  },

  monthly_net_income: {
    type: 'number', default: 93795, min: 0, step: 1, group: 'Cashflow',
    label: 'Monthly net income', prefix: '₹', hint: 'Take-home, after tax and deductions.',
  },
  monthly_expenses: {
    type: 'number', default: 40000, min: 0, step: 1, group: 'Cashflow',
    label: 'Monthly baseline expenses', prefix: '₹', hint: 'Drives both the FI target and the emergency runway.',
  },

  fi_multiplier: {
    type: 'number', default: 25, min: 10, max: 50, step: 0.5, group: 'Financial independence',
    label: 'FI multiplier', suffix: '×', hint: '25× annual expenses is the 4% safe-withdrawal rule.',
  },
  monthly_contribution: {
    type: 'number', default: 0, min: 0, step: 1000, group: 'Financial independence',
    label: 'Monthly contribution', prefix: '₹',
    hint: 'What you actually invest each month. Leave at 0 to use your budgeted surplus (income − expenses).',
  },
  expected_return: {
    type: 'number', default: 10, min: 0, max: 30, step: 0.25, group: 'Financial independence',
    label: 'Expected annual return', suffix: '%', hint: 'Nominal, before inflation. Used for projections.',
  },
  inflation_rate: {
    type: 'number', default: 5, min: 0, max: 20, step: 0.25, group: 'Financial independence',
    label: 'Expected inflation', suffix: '%', hint: 'Used when you project in today’s rupees.',
  },
  passive_income_yield: {
    type: 'number', default: 5, min: 0, max: 20, step: 0.25, group: 'Financial independence',
    label: 'Blended passive yield', suffix: '%', hint: 'Applied to stocks + mutual funds + FDs.',
  },
  wealth_score_divisor: {
    type: 'number', default: 10, min: 1, max: 50, step: 1, group: 'Financial independence',
    label: 'Wealth score divisor', hint: 'From "The Millionaire Next Door": age × income ÷ this.',
  },

  emergency_runway_target: {
    type: 'number', default: 6, min: 1, max: 36, step: 1, group: 'Safety',
    label: 'Emergency runway target', suffix: 'months', hint: 'Below this the runway KPI shows "Build up".',
  },
  emergency_fund_basis: {
    type: 'enum', default: 'accessible', group: 'Safety',
    options: [
      { value: 'cash_like',  label: 'Cash + FDs only (conservative)' },
      { value: 'accessible', label: 'Cash + stocks + mutual funds' },
    ],
    label: 'What counts as emergency money',
    hint: 'Market holdings can be down exactly when you need them — the conservative basis is the honest one.',
  },
  solvency_target: {
    type: 'number', default: 3, min: 1, max: 20, step: 0.5, group: 'Safety',
    label: 'Solvency ratio target', suffix: '×', hint: 'Assets ÷ liabilities. Above this reads "Strong".',
  },

  points_per_eur: {
    type: 'number', default: 50, min: 1, step: 1, group: 'Credit card',
    label: 'Points per EUR', suffix: 'pts', hint: 'HSBC TravelOne transfer ratio.',
  },
  cc_milestone_target: {
    type: 'number', default: 1200000, min: 0, step: 1000, group: 'Credit card',
    label: 'Annual spend milestone', prefix: '₹', hint: 'Spend needed for the fee waiver / bonus.',
  },
  cc_reward_target_rate: {
    type: 'number', default: 8, min: 0, max: 100, step: 0.5, group: 'Credit card',
    label: 'Reward rate target', suffix: '%', hint: 'Value returned as a percentage of spend.',
  },
  // Rows on the Points page are created from the ledger's card alerts
  // (0012_card_points.sql). This says which card. Work spend is a tick-box on
  // the row and on the merchant rule (0014), not a label, so it has no setting.
  cc_points_account: {
    type: 'string', default: '', group: 'Credit card',
    label: 'Points card, last four digits',
    hint: 'Only card alerts for this account create rows on the Points page. Every other card is ignored. Leave empty to switch automatic rows off.',
  },

  // ── Food ──────────────────────────────────────────────
  //
  // The target the Food page draws as a line and marks red when crossed. The
  // default is sized for this user's stated goal (90 → 75 kg): a mostly
  // sedentary ~90 kg adult burns roughly 2,300–2,500 kcal a day, so 1,800
  // leaves a 500–700 kcal deficit — about half a kilo a week, the sustainable
  // end of the range. Not medical advice; a number to eat against, tuned here
  // as the weight comes down.
  food_kcal_target: {
    type: 'number', default: 1800, min: 800, max: 6000, step: 50, group: 'Food',
    label: 'Daily calorie target', suffix: 'kcal',
    hint: 'The line on the Food chart. Days above it show red. ~1,800 gives a 90 kg adult a deficit of about half a kilo a week; recheck it every 5 kg lost.',
  },

  // ── Event ledger ──────────────────────────────────────
  //
  // The spec is explicit that confidence thresholds must not be baked into the
  // database. They live here as settings, and the SQL layer reads them through
  // ledger_setting() with these same defaults — so tightening what counts as
  // "reliable" is a settings change, not a migration.
  ledger_timezone: {
    type: 'string', default: 'Asia/Kolkata', group: 'Event ledger',
    label: 'Timezone', hint: 'Which clock "today" and the daily summary are measured against.',
  },
  ledger_self_identifiers: {
    type: 'string', default: '', group: 'Event ledger',
    label: 'Your own names and handles',
    hint: 'Comma-separated UPI handles, account names, VPAs. Transfers to these are recorded as moving your own money, not as spending.',
  },
  ledger_confidence_confirmed: {
    type: 'number', default: 0.90, min: 0.5, max: 1, step: 0.01, group: 'Event ledger',
    label: 'Confirmed above',
    hint: 'Extractions at or above this are treated as fact. Deterministic rules score 0.90+; the model is capped below it, so anything it produced always shows as inferred.',
  },
  ledger_confidence_review: {
    type: 'number', default: 0.75, min: 0.1, max: 1, step: 0.01, group: 'Event ledger',
    label: 'Review below', hint: 'Below this, an event goes to the review queue instead of the timeline.',
  },
  ledger_dedupe_window_minutes: {
    type: 'number', default: 180, min: 5, max: 1440, step: 5, group: 'Event ledger',
    label: 'Duplicate window', suffix: 'min',
    hint: 'How far apart two sources can describe the same event. A card alert can lag the receipt by hours.',
  },
  ledger_dedupe_amount_tolerance: {
    type: 'number', default: 0.02, min: 0, max: 0.5, step: 0.01, group: 'Event ledger',
    label: 'Amount tolerance', hint: 'Fractional difference still counted as the same amount. 0.02 = 2%.',
  },
  ledger_dedupe_min_name_similarity: {
    type: 'number', default: 0.30, min: 0, max: 1, step: 0.05, group: 'Event ledger',
    label: 'Name disagreement floor',
    hint: 'Below this similarity, two events are treated as different things even if the amount and time line up.',
  },
  ledger_dedupe_min_score: {
    type: 'number', default: 0.6, min: 0.1, max: 1, step: 0.05, group: 'Event ledger',
    label: 'Duplicate match threshold',
    hint: 'Higher means fewer merges and more duplicates; lower risks merging two genuinely separate events.',
  },
  ledger_corroboration_bump: {
    type: 'number', default: 0.03, min: 0, max: 0.2, step: 0.01, group: 'Event ledger',
    label: 'Corroboration bump', hint: 'Confidence added when an independent source confirms an event.',
  },
  ledger_entity_similarity: {
    type: 'number', default: 0.82, min: 0.5, max: 1, step: 0.01, group: 'Event ledger',
    label: 'Entity match threshold', hint: 'How alike two names must be to be treated as the same merchant or person.',
  },
  ledger_snippet_retention_days: {
    type: 'number', default: 90, min: 0, max: 3650, step: 1, group: 'Event ledger',
    label: 'Keep email snippets for', suffix: 'days',
    hint: 'Cached body text is only for debugging an extraction. The source reference itself is kept forever.',
  },
};

// A group is not just a heading: it says what the settings under it are for,
// and whether they are the kind anyone changes. The ledger's eleven matching
// thresholds sat at the same visual weight as "Monthly net income", which is
// the one field almost everybody edits.
export const SETTING_GROUPS = [
  { name: 'Profile', icon: 'fa-user',
    blurb: 'Who the projections are about.' },
  { name: 'Cashflow', icon: 'fa-arrow-right-arrow-left',
    blurb: 'What comes in and what goes out each month. Almost everything else is derived from these two.' },
  { name: 'Financial independence', icon: 'fa-bullseye',
    blurb: 'The target, and the assumptions the path to it is drawn with.' },
  { name: 'Safety', icon: 'fa-shield-halved',
    blurb: 'How much cushion counts as enough, and what counts as cushion.' },
  { name: 'Credit card', icon: 'fa-credit-card',
    blurb: 'HSBC TravelOne: the transfer ratio and the targets the Points screen measures against.' },
  { name: 'Food', icon: 'fa-utensils',
    blurb: 'The one number the Food screen measures every day against.' },
  { name: 'Event ledger', icon: 'fa-timeline', advanced: true,
    blurb: 'How email is turned into events: what counts as certain, and when two sources are describing the same thing. The defaults are tuned against a real inbox — change them only if the timeline is getting things wrong.' },
];

/** Just the names, in order. The database and the tests only need these. */
export const SETTING_GROUP_NAMES = SETTING_GROUPS.map(g => g.name);

/** Defaults for every key: what applies before load, and for any key never saved. */
export function settingDefaults() {
  return Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([key, spec]) => [key, spec.default]));
}

/**
 * Stored values over defaults, each marked with where it came from — so a
 * reader can tell the user's own number from the app's guess.
 */
export function resolveSettings(stored = {}) {
  return Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([key, spec]) => {
    const saved = Object.prototype.hasOwnProperty.call(stored, key) && stored[key] !== null;
    return [key, {
      value: saved ? stored[key] : spec.default,
      set_by: saved ? 'user' : 'default',
      label: spec.label, group: spec.group,
      unit: spec.suffix || spec.prefix || undefined,
    }];
  }));
}
