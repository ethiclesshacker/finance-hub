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
    label: 'Age', hint: 'Drives the wealth score and the Coast FI horizon.',
  },
  retirement_age: {
    type: 'number', default: 60, min: 30, max: 100, step: 1, group: 'Profile',
    label: 'Target retirement age', hint: 'The age Coast FI compounds towards.',
  },

  monthly_net_income: {
    type: 'number', default: 93795, min: 0, step: 1, group: 'Cashflow',
    label: 'Monthly net income (₹)', hint: 'Take-home, after tax and deductions.',
  },
  monthly_expenses: {
    type: 'number', default: 40000, min: 0, step: 1, group: 'Cashflow',
    label: 'Monthly baseline expenses (₹)', hint: 'Drives both the FI target and the emergency runway.',
  },

  fi_multiplier: {
    type: 'number', default: 25, min: 10, max: 50, step: 0.5, group: 'Financial independence',
    label: 'FI multiplier', hint: '25× annual expenses is the 4% safe-withdrawal rule.',
  },
  monthly_contribution: {
    type: 'number', default: 0, min: 0, step: 1000, group: 'Financial independence',
    label: 'Monthly contribution (₹)',
    hint: 'What you actually invest each month. Leave at 0 to use your budgeted surplus (income − expenses).',
  },
  expected_return: {
    type: 'number', default: 10, min: 0, max: 30, step: 0.25, group: 'Financial independence',
    label: 'Expected annual return (%)', hint: 'Nominal, before inflation. Used for projections.',
  },
  inflation_rate: {
    type: 'number', default: 5, min: 0, max: 20, step: 0.25, group: 'Financial independence',
    label: 'Expected inflation (%)', hint: 'Used when you project in today’s rupees.',
  },
  passive_income_yield: {
    type: 'number', default: 5, min: 0, max: 20, step: 0.25, group: 'Financial independence',
    label: 'Blended passive yield (%)', hint: 'Applied to stocks + mutual funds + FDs.',
  },
  wealth_score_divisor: {
    type: 'number', default: 10, min: 1, max: 50, step: 1, group: 'Financial independence',
    label: 'Wealth score divisor', hint: 'From "The Millionaire Next Door": age × income ÷ this.',
  },

  emergency_runway_target: {
    type: 'number', default: 6, min: 1, max: 36, step: 1, group: 'Safety',
    label: 'Emergency runway target (months)', hint: 'Below this the runway KPI shows "Build up".',
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
    label: 'Solvency ratio target (×)', hint: 'Assets ÷ liabilities. Above this reads "Strong".',
  },

  points_per_eur: {
    type: 'number', default: 50, min: 1, step: 1, group: 'Credit card',
    label: 'Points per EUR', hint: 'HSBC TravelOne transfer ratio.',
  },
  cc_milestone_target: {
    type: 'number', default: 1200000, min: 0, step: 1000, group: 'Credit card',
    label: 'Annual spend milestone (₹)', hint: 'Spend needed for the fee waiver / bonus.',
  },
  cc_reward_target_rate: {
    type: 'number', default: 8, min: 0, max: 100, step: 0.5, group: 'Credit card',
    label: 'Reward rate target (%)', hint: 'Value returned as a percentage of spend.',
  },
};

export const SETTING_GROUPS = ['Profile', 'Cashflow', 'Financial independence', 'Safety', 'Credit card'];

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
