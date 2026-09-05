import { supabase, getCurrentUserId } from './supabase.js';

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

/** Defaults for every key, used before load and for any row the user has never saved. */
function defaults() {
  return Object.fromEntries(
    Object.entries(SETTINGS_SCHEMA).map(([key, spec]) => [key, spec.default])
  );
}

let cache = defaults();
let loaded = false;

/**
 * Coerce a stored value to its declared type. jsonb round-trips types properly,
 * but a hand-edited row (or a schema change that retypes a key) shouldn't be
 * able to poison the whole app with a string where a number belongs.
 */
function coerce(key, raw) {
  const spec = SETTINGS_SCHEMA[key];
  if (!spec) return undefined; // unknown key — the schema is the allow-list

  if (spec.type === 'number') {
    const n = typeof raw === 'number' ? raw : parseFloat(raw);
    if (!Number.isFinite(n)) return spec.default;
    if (spec.min !== undefined && n < spec.min) return spec.min;
    if (spec.max !== undefined && n > spec.max) return spec.max;
    return n;
  }
  if (spec.type === 'enum') {
    return spec.options.some(o => o.value === raw) ? raw : spec.default;
  }
  if (spec.type === 'boolean') return Boolean(raw);
  return raw == null ? spec.default : String(raw);
}

/** Fetch this user's settings and merge them over the defaults. */
export async function loadSettings() {
  const next = defaults();

  const { data, error } = await supabase.from('user_settings').select('key, value');

  if (error) {
    // A missing table (before the migration is run) or a network blip must not
    // take the app down — defaults are always a usable answer.
    console.warn('[settings] falling back to defaults:', error.message);
    cache = next;
    loaded = true;
    return { settings: cache, error };
  }

  for (const row of data || []) {
    const value = coerce(row.key, row.value);
    if (value !== undefined) next[row.key] = value;
  }

  cache = next;
  loaded = true;
  return { settings: cache, error: null };
}

/** Synchronous read. Returns the default until loadSettings() has resolved. */
export function get(key) {
  return cache[key];
}

/** The whole settings object (a copy — mutating it does nothing). */
export function all() {
  return { ...cache };
}

export function isLoaded() {
  return loaded;
}

/** Persist a patch of {key: value}. Only keys in the schema are written. */
export async function saveSettings(patch) {
  const userId = await getCurrentUserId();
  if (!userId) return { error: new Error('Not signed in.') };

  const rows = Object.entries(patch)
    .filter(([key]) => key in SETTINGS_SCHEMA)
    .map(([key, value]) => ({ user_id: userId, key, value: coerce(key, value) }));

  if (!rows.length) return { error: null };

  const { error } = await supabase
    .from('user_settings')
    .upsert(rows, { onConflict: 'user_id,key' });

  if (!error) {
    for (const row of rows) cache[row.key] = row.value;
  }
  return { error };
}

/** Restore a single key to its schema default by deleting the stored row. */
export async function resetSetting(key) {
  const userId = await getCurrentUserId();
  if (!userId) return { error: new Error('Not signed in.') };

  const { error } = await supabase
    .from('user_settings').delete().eq('user_id', userId).eq('key', key);

  if (!error) cache[key] = SETTINGS_SCHEMA[key].default;
  return { error };
}

// ======================================================
// Derived values — computed from settings, never stored.
// Storing a derived number is how it goes stale.
// ======================================================

export function annualExpenses() {
  return get('monthly_expenses') * 12;
}

export function fiTarget() {
  return annualExpenses() * get('fi_multiplier');
}

/** Monthly surplus implied by the budget, before any investment return. */
export function budgetedSurplus() {
  return get('monthly_net_income') - get('monthly_expenses');
}

/**
 * What the projections should actually contribute each month.
 *
 * An explicit `monthly_contribution` wins; 0 means "I haven't set one", so fall
 * back to what the budget implies. Budgeted surplus is a plan, not a fact — if
 * you've saved a real number, that's the better input.
 */
export function plannedContribution() {
  const explicit = get('monthly_contribution');
  return explicit > 0 ? explicit : Math.max(0, budgetedSurplus());
}

/** Savings rate the budget implies, as a percentage of take-home. */
export function budgetedSavingsRate() {
  const income = get('monthly_net_income');
  return income > 0 ? (budgetedSurplus() / income) * 100 : 0;
}

/** Return net of inflation, as a decimal. Fisher equation, not a subtraction. */
export function realReturnRate() {
  const nominal = get('expected_return') / 100;
  const inflation = get('inflation_rate') / 100;
  return (1 + nominal) / (1 + inflation) - 1;
}
